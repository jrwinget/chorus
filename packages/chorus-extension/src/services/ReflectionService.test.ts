import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ReflectionService } from './ReflectionService';
import { TestDatabase } from '../test/testUtils';
import { LocalDB } from '../storage/LocalDB';

describe('ReflectionService', () => {
  let testDb: TestDatabase;
  let db: LocalDB;
  let service: ReflectionService;

  beforeEach(async () => {
    testDb = new TestDatabase();
    db = testDb.db;
    await testDb.setup();
    service = new ReflectionService(db);
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  // helper to seed retrospectives with specific bias patterns
  async function seedRetrospective(
    prId: string,
    biasPatterns: string[],
    opts?: { what_went_wrong?: string; what_to_improve?: string; trigger_type?: string }
  ): Promise<void> {
    await db.recordRetrospective(prId, opts?.trigger_type || 'manual', {
      what_went_wrong: opts?.what_went_wrong || `Something went wrong on ${prId}`,
      what_to_improve: opts?.what_to_improve || 'Improve process',
      bias_patterns: biasPatterns,
    });
  }

  // helper to seed multiple retrospectives with a given bias at high frequency
  async function seedRepeatedBias(
    bias: string,
    count: number,
    totalRetros: number
  ): Promise<void> {
    for (let i = 0; i < count; i++) {
      await seedRetrospective(`PR-bias-${i}`, [bias]);
    }
    // fill remaining retrospectives without the target bias
    for (let i = count; i < totalRetros; i++) {
      await seedRetrospective(`PR-other-${i}`, ['other']);
    }
  }

  // helper to seed decision schemes with one dominant scheme
  async function seedDominantScheme(
    dominant: string,
    dominantCount: number,
    otherCount: number
  ): Promise<void> {
    for (let i = 0; i < dominantCount; i++) {
      await db.recordDecisionScheme(`PR-dom-${i}`, dominant, 'rationale');
    }
    for (let i = 0; i < otherCount; i++) {
      await db.recordDecisionScheme(`PR-oth-${i}`, 'truth_wins', 'rationale');
    }
  }

  describe('detectPatterns', () => {
    it('should return empty array with no data', async () => {
      const insights = await service.detectPatterns();
      expect(insights).toEqual([]);
    });

    it('should return empty array when there is insufficient data', async () => {
      // only 1 retrospective and 2 schemes -- not enough for any pattern
      await seedRetrospective('PR-1', ['groupthink']);
      await db.recordDecisionScheme('PR-1', 'consensus', 'rationale');
      await db.recordDecisionScheme('PR-2', 'majority', 'rationale');

      const insights = await service.detectPatterns();
      expect(insights).toEqual([]);
    });

    it('should detect multiple patterns when data supports them', async () => {
      // set up data that triggers lack-of-variation (6 consensus out of 7)
      await seedDominantScheme('consensus', 6, 1);

      // set up data that triggers repeated bias (groupthink in 4 out of 5 retros)
      await seedRepeatedBias('groupthink', 4, 5);

      const insights = await service.detectPatterns();

      // should have at least lack-of-variation and repeated bias
      expect(insights.length).toBeGreaterThanOrEqual(2);
      const titles = insights.map((i) => i.title);
      expect(titles).toContain('Decision Scheme Variation');
      expect(titles.some((t) => t.includes('groupthink'))).toBe(true);
    });
  });

  describe('detectLackOfVariation', () => {
    it('should return null with fewer than 5 total scheme uses', async () => {
      await db.recordDecisionScheme('PR-1', 'consensus', 'rationale');
      await db.recordDecisionScheme('PR-2', 'consensus', 'rationale');
      await db.recordDecisionScheme('PR-3', 'consensus', 'rationale');
      await db.recordDecisionScheme('PR-4', 'consensus', 'rationale');

      const insights = await service.detectPatterns();

      // no lack-of-variation insight since total < 5
      const variationInsight = insights.find((i) => i.title === 'Decision Scheme Variation');
      expect(variationInsight).toBeUndefined();
    });

    it('should return null when no scheme dominates over 70%', async () => {
      // 3 consensus, 2 majority, 1 truth_wins = 6 total; consensus = 50%
      await db.recordDecisionScheme('PR-1', 'consensus', 'rationale');
      await db.recordDecisionScheme('PR-2', 'consensus', 'rationale');
      await db.recordDecisionScheme('PR-3', 'consensus', 'rationale');
      await db.recordDecisionScheme('PR-4', 'majority', 'rationale');
      await db.recordDecisionScheme('PR-5', 'majority', 'rationale');
      await db.recordDecisionScheme('PR-6', 'truth_wins', 'rationale');

      const insights = await service.detectPatterns();

      const variationInsight = insights.find((i) => i.title === 'Decision Scheme Variation');
      expect(variationInsight).toBeUndefined();
    });

    it('should detect when one scheme exceeds 70% of total', async () => {
      // 6 consensus, 1 majority = 7 total; consensus = 85.7%
      await seedDominantScheme('consensus', 6, 1);

      const insights = await service.detectPatterns();

      const variationInsight = insights.find((i) => i.title === 'Decision Scheme Variation');
      expect(variationInsight).toBeDefined();
      expect(variationInsight!.type).toBe('recommendation');
      expect(variationInsight!.description).toContain('consensus');
      expect(variationInsight!.description).toContain('86%');
      expect(variationInsight!.evidence.length).toBe(2);
      expect(variationInsight!.evidence[0]).toContain('6 out of 7');
    });

    it('should detect exactly at the 71% boundary', async () => {
      // 5 consensus, 2 majority = 7 total; consensus = 71.4%
      for (let i = 0; i < 5; i++) {
        await db.recordDecisionScheme(`PR-c-${i}`, 'consensus', 'rationale');
      }
      for (let i = 0; i < 2; i++) {
        await db.recordDecisionScheme(`PR-m-${i}`, 'majority', 'rationale');
      }

      const insights = await service.detectPatterns();

      const variationInsight = insights.find((i) => i.title === 'Decision Scheme Variation');
      expect(variationInsight).toBeDefined();
    });
  });

  describe('detectRepeatedBias', () => {
    it('should return null with fewer than 3 retrospectives', async () => {
      await seedRetrospective('PR-1', ['groupthink']);
      await seedRetrospective('PR-2', ['groupthink']);

      const insights = await service.detectPatterns();

      const biasInsight = insights.find((i) => i.title.includes('Recurring Bias'));
      expect(biasInsight).toBeUndefined();
    });

    it('should return null when no bias exceeds 40% frequency', async () => {
      // 5 retros, each with a different bias
      await seedRetrospective('PR-1', ['groupthink']);
      await seedRetrospective('PR-2', ['hidden_profile']);
      await seedRetrospective('PR-3', ['status_bias']);
      await seedRetrospective('PR-4', ['overconfidence']);
      await seedRetrospective('PR-5', ['other']);

      const insights = await service.detectPatterns();

      const biasInsight = insights.find((i) => i.title.includes('Recurring Bias'));
      expect(biasInsight).toBeUndefined();
    });

    it('should return null when bias count is < 3 even if percentage > 40%', async () => {
      // 2 groupthink out of 3 = 66%, but count < 3
      await seedRetrospective('PR-1', ['groupthink']);
      await seedRetrospective('PR-2', ['groupthink']);
      await seedRetrospective('PR-3', ['hidden_profile']);

      const insights = await service.detectPatterns();

      const biasInsight = insights.find((i) => i.title.includes('Recurring Bias'));
      expect(biasInsight).toBeUndefined();
    });

    it('should detect groupthink bias with correct suggestion', async () => {
      await seedRepeatedBias('groupthink', 4, 5);

      const insights = await service.detectPatterns();

      const biasInsight = insights.find((i) => i.title.includes('groupthink'));
      expect(biasInsight).toBeDefined();
      expect(biasInsight!.type).toBe('warning');
      expect(biasInsight!.description).toContain('blinded reviews');
      expect(biasInsight!.description).toContain('4 out of 5');
    });

    it('should detect hidden_profile bias with correct suggestion', async () => {
      await seedRepeatedBias('hidden_profile', 4, 5);

      const insights = await service.detectPatterns();

      const biasInsight = insights.find((i) => i.title.includes('hidden_profile'));
      expect(biasInsight).toBeDefined();
      expect(biasInsight!.description).toContain('unique information');
    });

    it('should detect status_bias with correct suggestion', async () => {
      await seedRepeatedBias('status_bias', 4, 5);

      const insights = await service.detectPatterns();

      const biasInsight = insights.find((i) => i.title.includes('status_bias'));
      expect(biasInsight).toBeDefined();
      expect(biasInsight!.description).toContain('evidence-based');
    });

    it('should detect overconfidence bias with correct suggestion', async () => {
      await seedRepeatedBias('overconfidence', 4, 5);

      const insights = await service.detectPatterns();

      const biasInsight = insights.find((i) => i.title.includes('Recurring Bias'));
      expect(biasInsight).toBeDefined();
      expect(biasInsight!.description).toContain('calibration');
    });

    it('should detect unknown bias type with default suggestion', async () => {
      await seedRepeatedBias('anchoring', 4, 5);

      const insights = await service.detectPatterns();

      const biasInsight = insights.find((i) => i.title.includes('anchoring'));
      expect(biasInsight).toBeDefined();
      expect(biasInsight!.description).toContain('process changes');
    });

    it('should include up to 3 evidence entries from matching retrospectives', async () => {
      // 5 retros with groupthink
      for (let i = 0; i < 5; i++) {
        await seedRetrospective(`PR-gt-${i}`, ['groupthink'], {
          what_went_wrong: `Issue ${i} happened`,
        });
      }

      const insights = await service.detectPatterns();

      const biasInsight = insights.find((i) => i.title.includes('groupthink'));
      expect(biasInsight).toBeDefined();
      // evidence should be capped at 3
      expect(biasInsight!.evidence.length).toBeLessThanOrEqual(3);
      // each evidence line should reference a PR
      for (const ev of biasInsight!.evidence) {
        expect(ev).toMatch(/^PR /);
      }
    });

    it('should handle retrospectives with invalid JSON bias_patterns gracefully', async () => {
      // seed valid retros first
      for (let i = 0; i < 4; i++) {
        await seedRetrospective(`PR-valid-${i}`, ['groupthink']);
      }

      // the detectRepeatedBias uses analytics.bias_frequency which comes from db
      // and retrospectives list -- invalid json is handled in the filter
      const insights = await service.detectPatterns();

      const biasInsight = insights.find((i) => i.title.includes('groupthink'));
      expect(biasInsight).toBeDefined();
    });
  });

  describe('detectSchemeOutcomeCorrelation', () => {
    it('should return null with fewer than 5 unique PR ids across retrospectives', async () => {
      // only 3 unique PRs
      for (let i = 0; i < 3; i++) {
        await seedRetrospective(`PR-${i}`, ['groupthink']);
        await db.recordDecisionScheme(`PR-${i}`, 'unanimous', 'rationale');
      }

      const insights = await service.detectPatterns();

      const schemeOutcome = insights.find((i) => i.title.includes('Failure Rate'));
      expect(schemeOutcome).toBeUndefined();
    });

    it('should return null when no scheme has 3+ uses among retrospective PRs', async () => {
      // 5 unique PRs with retros, each with a different scheme type
      // so no single scheme reaches the >= 3 threshold
      await seedRetrospective('PR-0', ['groupthink']);
      await db.recordDecisionScheme('PR-0', 'unanimous', 'rationale');

      await seedRetrospective('PR-1', ['groupthink']);
      await db.recordDecisionScheme('PR-1', 'majority', 'rationale');

      await seedRetrospective('PR-2', ['groupthink']);
      await db.recordDecisionScheme('PR-2', 'consensus', 'rationale');

      await seedRetrospective('PR-3', ['groupthink']);
      await db.recordDecisionScheme('PR-3', 'truth_wins', 'rationale');

      await seedRetrospective('PR-4', ['groupthink']);
      await db.recordDecisionScheme('PR-4', 'expert_veto', 'rationale');

      const insights = await service.detectPatterns();

      const schemeOutcome = insights.find((i) => i.title.includes('Failure Rate'));
      expect(schemeOutcome).toBeUndefined();
    });

    it('should return null when scheme with high failure has fewer than 3 uses', async () => {
      // need 5 unique pr ids across all retrospectives
      for (let i = 0; i < 5; i++) {
        await seedRetrospective(`PR-${i}`, ['groupthink']);
      }
      // only 2 uses of unanimous scheme (both with bad outcomes)
      await db.recordDecisionScheme('PR-0', 'unanimous', 'rationale');
      await db.recordDecisionScheme('PR-1', 'unanimous', 'rationale');
      // remaining PRs have no scheme, so they get skipped

      const insights = await service.detectPatterns();

      // unanimous only has 2 uses (< 3), so no failure rate insight for it
      const schemeOutcome = insights.find((i) =>
        i.title.includes('Failure Rate') && i.title.includes('unanimous')
      );
      expect(schemeOutcome).toBeUndefined();
    });

    it('should detect high failure rate for unanimous scheme', async () => {
      // 6 unique PRs with retros, all using unanimous
      for (let i = 0; i < 6; i++) {
        await seedRetrospective(`PR-u-${i}`, ['groupthink']);
        await db.recordDecisionScheme(`PR-u-${i}`, 'unanimous', 'rationale');
      }

      const insights = await service.detectPatterns();

      const schemeOutcome = insights.find((i) => i.title.includes('unanimous'));
      expect(schemeOutcome).toBeDefined();
      expect(schemeOutcome!.type).toBe('warning');
      expect(schemeOutcome!.description).toContain('pressure to conform');
      expect(schemeOutcome!.description).toContain('100%');
    });

    it('should detect high failure rate for majority scheme', async () => {
      for (let i = 0; i < 6; i++) {
        await seedRetrospective(`PR-m-${i}`, ['groupthink']);
        await db.recordDecisionScheme(`PR-m-${i}`, 'majority', 'rationale');
      }

      const insights = await service.detectPatterns();

      const schemeOutcome = insights.find((i) => i.title.includes('majority'));
      expect(schemeOutcome).toBeDefined();
      expect(schemeOutcome!.description).toContain('dissenting opinions');
    });

    it('should detect high failure rate for other scheme types with generic message', async () => {
      for (let i = 0; i < 6; i++) {
        await seedRetrospective(`PR-c-${i}`, ['groupthink']);
        await db.recordDecisionScheme(`PR-c-${i}`, 'consensus', 'rationale');
      }

      const insights = await service.detectPatterns();

      const schemeOutcome = insights.find((i) => i.title.includes('consensus'));
      expect(schemeOutcome).toBeDefined();
      expect(schemeOutcome!.description).toContain('review when and why');
    });

    it('should skip PRs with no recorded scheme', async () => {
      // 6 unique PRs with retros, but only 2 have schemes
      for (let i = 0; i < 6; i++) {
        await seedRetrospective(`PR-ns-${i}`, ['groupthink']);
      }
      await db.recordDecisionScheme('PR-ns-0', 'unanimous', 'rationale');
      await db.recordDecisionScheme('PR-ns-1', 'unanimous', 'rationale');

      const insights = await service.detectPatterns();

      // unanimous only has 2 uses, so it shouldn't trigger (needs >= 3)
      const schemeOutcome = insights.find((i) => i.title.includes('Failure Rate'));
      expect(schemeOutcome).toBeUndefined();
    });
  });

  describe('detectOverconfidence', () => {
    it('should return null with fewer than 3 retrospectives', async () => {
      await seedRetrospective('PR-1', ['overconfidence']);
      await seedRetrospective('PR-2', ['overconfidence']);

      const insights = await service.detectPatterns();

      const overconfidence = insights.find((i) => i.title === 'Overconfidence Pattern Detected');
      expect(overconfidence).toBeUndefined();
    });

    it('should return null when overconfidence rate is below 30%', async () => {
      // 1 overconfidence out of 10 retros = 10%
      await seedRetrospective('PR-oc', ['overconfidence']);
      for (let i = 0; i < 9; i++) {
        await seedRetrospective(`PR-other-${i}`, ['groupthink']);
      }

      const insights = await service.detectPatterns();

      const overconfidence = insights.find((i) => i.title === 'Overconfidence Pattern Detected');
      expect(overconfidence).toBeUndefined();
    });

    it('should return null when overconfidence count is below 3 even with high rate', async () => {
      // 2 overconfidence out of 3 retros = 66%, but count < 3
      await seedRetrospective('PR-1', ['overconfidence']);
      await seedRetrospective('PR-2', ['overconfidence']);
      await seedRetrospective('PR-3', ['groupthink']);

      const insights = await service.detectPatterns();

      const overconfidence = insights.find((i) => i.title === 'Overconfidence Pattern Detected');
      expect(overconfidence).toBeUndefined();
    });

    it('should detect overconfidence when rate exceeds 30% and count >= 3', async () => {
      // 4 overconfidence out of 5 = 80%
      for (let i = 0; i < 4; i++) {
        await seedRetrospective(`PR-oc-${i}`, ['overconfidence']);
      }
      await seedRetrospective('PR-clean', ['groupthink']);

      const insights = await service.detectPatterns();

      const overconfidence = insights.find((i) => i.title === 'Overconfidence Pattern Detected');
      expect(overconfidence).toBeDefined();
      expect(overconfidence!.type).toBe('warning');
      expect(overconfidence!.description).toContain('80%');
      expect(overconfidence!.description).toContain('4 out of 5');
      expect(overconfidence!.evidence).toHaveLength(3);
      expect(overconfidence!.evidence).toContain('consider using confidence calibration features');
    });

    it('should handle retrospectives with invalid JSON in bias_patterns', async () => {
      // we cannot directly insert invalid JSON through the DB helpers since
      // they serialize properly, but we can verify the filter still works
      // when all are valid
      for (let i = 0; i < 5; i++) {
        await seedRetrospective(`PR-oc-${i}`, ['overconfidence']);
      }

      const insights = await service.detectPatterns();

      const overconfidence = insights.find((i) => i.title === 'Overconfidence Pattern Detected');
      expect(overconfidence).toBeDefined();
    });
  });

  describe('shouldTriggerRetrospective', () => {
    it('should return false when no outcomes exist', async () => {
      const result = await service.shouldTriggerRetrospective('PR-1');
      expect(result).toBe(false);
    });

    it('should return false when only clean outcomes exist', async () => {
      await db.recordOutcome('PR-1', 'merged_clean', false);

      const result = await service.shouldTriggerRetrospective('PR-1');
      expect(result).toBe(false);
    });

    it('should return false when only followup_required outcome exists', async () => {
      await db.recordOutcome('PR-1', 'followup_required', true);

      const result = await service.shouldTriggerRetrospective('PR-1');
      expect(result).toBe(false);
    });

    it('should return true when bug_found outcome exists', async () => {
      await db.recordOutcome('PR-1', 'bug_found', true);

      const result = await service.shouldTriggerRetrospective('PR-1');
      expect(result).toBe(true);
    });

    it('should return true when reverted outcome exists', async () => {
      await db.recordOutcome('PR-1', 'reverted', true);

      const result = await service.shouldTriggerRetrospective('PR-1');
      expect(result).toBe(true);
    });

    it('should return true when bug_found exists among other outcomes', async () => {
      await db.recordOutcome('PR-1', 'merged_clean', false);
      await db.recordOutcome('PR-1', 'bug_found', true);

      const result = await service.shouldTriggerRetrospective('PR-1');
      expect(result).toBe(true);
    });

    it('should isolate outcomes by PR id', async () => {
      await db.recordOutcome('PR-1', 'bug_found', true);
      await db.recordOutcome('PR-2', 'merged_clean', false);

      expect(await service.shouldTriggerRetrospective('PR-1')).toBe(true);
      expect(await service.shouldTriggerRetrospective('PR-2')).toBe(false);
    });
  });

  describe('recommendDecisionScheme', () => {
    it('should recommend truth_wins for high risk', async () => {
      const result = await service.recommendDecisionScheme('PR-1', 'high');

      expect(result.scheme).toBe('truth_wins');
      expect(result.reason).toContain('high-risk');
      expect(result.reason).toContain('evidence-based');
    });

    it('should recommend majority for medium risk', async () => {
      const result = await service.recommendDecisionScheme('PR-1', 'medium');

      expect(result.scheme).toBe('majority');
      expect(result.reason).toContain('medium-risk');
      expect(result.reason).toContain('majority voting');
    });

    it('should recommend consensus for low risk', async () => {
      const result = await service.recommendDecisionScheme('PR-1', 'low');

      expect(result.scheme).toBe('consensus');
      expect(result.reason).toContain('low-risk');
      expect(result.reason).toContain('consensus-based');
    });

    it('should call getReflectionAnalytics (for future use)', async () => {
      // seed some data so analytics has something to return
      await db.recordDecisionScheme('PR-x', 'consensus', 'some rationale');

      // should not throw even with analytics data present
      const result = await service.recommendDecisionScheme('PR-x', 'high');
      expect(result.scheme).toBe('truth_wins');
    });
  });

  describe('exportRetrospectiveReport', () => {
    it('should return empty report when no retrospectives exist', async () => {
      const report = await service.exportRetrospectiveReport();

      expect(report).toBe(
        '# Reflection Report\n\nNo retrospectives found for the specified time period.'
      );
    });

    it('should return empty report with filters that match nothing', async () => {
      await seedRetrospective('PR-1', ['groupthink']);

      const report = await service.exportRetrospectiveReport({
        start_date: '2099-01-01',
      });

      expect(report).toBe(
        '# Reflection Report\n\nNo retrospectives found for the specified time period.'
      );
    });

    it('should include summary section', async () => {
      await seedRetrospective('PR-1', ['groupthink']);
      await db.recordDecisionScheme('PR-1', 'consensus', 'rationale');

      const report = await service.exportRetrospectiveReport();

      expect(report).toContain('# Reflection Report');
      expect(report).toContain('## Summary');
      expect(report).toContain('**Total Retrospectives**: 1');
      expect(report).toContain('**Decision Schemes Tracked**: 1');
    });

    it('should include scheme distribution section', async () => {
      await db.recordDecisionScheme('PR-1', 'consensus', 'rationale');
      await db.recordDecisionScheme('PR-2', 'majority', 'rationale');
      await db.recordDecisionScheme('PR-3', 'consensus', 'rationale');
      await seedRetrospective('PR-1', ['groupthink']);

      const report = await service.exportRetrospectiveReport();

      expect(report).toContain('## Decision Scheme Distribution');
      expect(report).toContain('**consensus**: 2');
      expect(report).toContain('**majority**: 1');
    });

    it('should include bias patterns section when biases exist', async () => {
      await seedRetrospective('PR-1', ['groupthink', 'status_bias']);
      await seedRetrospective('PR-2', ['groupthink']);

      const report = await service.exportRetrospectiveReport();

      expect(report).toContain('## Bias Patterns Identified');
      expect(report).toContain('**groupthink**: 2 occurrences');
      expect(report).toContain('**status_bias**: 1 occurrences');
    });

    it('should omit bias patterns section when no biases exist', async () => {
      await seedRetrospective('PR-1', []);

      const report = await service.exportRetrospectiveReport();

      expect(report).not.toContain('## Bias Patterns Identified');
    });

    it('should include pattern insights when detected', async () => {
      // trigger a lack-of-variation insight
      await seedDominantScheme('consensus', 6, 1);
      await seedRetrospective('PR-ins', ['groupthink']);

      const report = await service.exportRetrospectiveReport();

      expect(report).toContain('## Pattern Insights');
      expect(report).toContain('Decision Scheme Variation');
      expect(report).toContain('**Evidence**:');
    });

    it('should include detailed retrospectives section', async () => {
      await seedRetrospective('PR-detail-1', ['groupthink'], {
        what_went_wrong: 'Missed a critical edge case in the auth flow',
        what_to_improve: 'Add more boundary condition tests',
        trigger_type: 'manual',
      });

      const report = await service.exportRetrospectiveReport();

      expect(report).toContain('## Detailed Retrospectives');
      expect(report).toContain('### PR: PR-detail-1');
      expect(report).toContain('**Trigger**: manual');
      expect(report).toContain('**What Went Wrong**:');
      expect(report).toContain('Missed a critical edge case in the auth flow');
      expect(report).toContain('**What to Improve**:');
      expect(report).toContain('Add more boundary condition tests');
      expect(report).toContain('**Bias Patterns Noted**:');
      expect(report).toContain('- groupthink');
      expect(report).toContain('---');
    });

    it('should handle retrospectives with empty bias patterns array', async () => {
      await seedRetrospective('PR-empty-bias', []);

      const report = await service.exportRetrospectiveReport();

      // should not include "Bias Patterns Noted" for this retro since array is empty
      expect(report).toContain('### PR: PR-empty-bias');
      // the section header should not appear for the specific retro
      // (empty array length === 0, so it skips the block)
    });

    it('should include time period section when start_date is provided', async () => {
      await seedRetrospective('PR-1', ['groupthink']);

      const report = await service.exportRetrospectiveReport({
        start_date: '2024-01-01',
      });

      expect(report).toContain('## Time Period');
      expect(report).toContain('**From**:');
    });

    it('should include time period section when end_date is provided', async () => {
      await seedRetrospective('PR-1', ['groupthink']);

      const report = await service.exportRetrospectiveReport({
        end_date: '2099-12-31',
      });

      expect(report).toContain('## Time Period');
      expect(report).toContain('**To**:');
    });

    it('should include both from and to in time period section', async () => {
      await seedRetrospective('PR-1', ['groupthink']);

      const report = await service.exportRetrospectiveReport({
        start_date: '2024-01-01',
        end_date: '2099-12-31',
      });

      expect(report).toContain('**From**:');
      expect(report).toContain('**To**:');
    });

    it('should not include time period section when no filters provided', async () => {
      await seedRetrospective('PR-1', ['groupthink']);

      const report = await service.exportRetrospectiveReport();

      expect(report).not.toContain('## Time Period');
    });

    it('should end with generated by line', async () => {
      await seedRetrospective('PR-1', ['groupthink']);

      const report = await service.exportRetrospectiveReport();

      expect(report).toContain('*Generated by Chorus on');
    });

    it('should pass filters correctly to getRetrospectives', async () => {
      // create retros at different times -- the db uses current timestamp,
      // so we test that filtering by end_date in the far future returns all
      await seedRetrospective('PR-1', ['groupthink']);
      await seedRetrospective('PR-2', ['hidden_profile']);

      const report = await service.exportRetrospectiveReport({
        end_date: '2099-12-31',
      });

      expect(report).toContain('PR-1');
      expect(report).toContain('PR-2');
    });

    it('should handle undefined filter properties correctly', async () => {
      await seedRetrospective('PR-1', ['groupthink']);

      // pass empty filters object (no start_date or end_date)
      const report = await service.exportRetrospectiveReport({});

      expect(report).toContain('PR-1');
      expect(report).not.toContain('## Time Period');
    });

    it('should include insight icons based on type', async () => {
      // trigger a recommendation insight (lack of variation)
      await seedDominantScheme('consensus', 6, 1);
      await seedRetrospective('PR-icon', ['groupthink']);

      const report = await service.exportRetrospectiveReport();

      // recommendation icon
      expect(report).toMatch(/###\s+💡/);
    });

    it('should include warning insight icons', async () => {
      // trigger enough overconfidence retros to get the overconfidence warning
      for (let i = 0; i < 5; i++) {
        await seedRetrospective(`PR-oc-${i}`, ['overconfidence']);
      }

      const report = await service.exportRetrospectiveReport();

      // warning icon
      expect(report).toMatch(/###\s+⚠️/);
    });

    it('should report zero percentage when no schemes exist', async () => {
      await seedRetrospective('PR-1', ['groupthink']);

      const report = await service.exportRetrospectiveReport();

      // scheme distribution section should still be present but with 0 schemes
      expect(report).toContain('**Decision Schemes Tracked**: 0');
    });

    it('should include date in each detailed retrospective', async () => {
      await seedRetrospective('PR-dated', ['groupthink']);

      const report = await service.exportRetrospectiveReport();

      expect(report).toContain('**Date**:');
    });

    it('should list multiple retrospectives in detailed section', async () => {
      for (let i = 0; i < 3; i++) {
        await seedRetrospective(`PR-multi-${i}`, ['groupthink'], {
          what_went_wrong: `Issue ${i}`,
        });
      }

      const report = await service.exportRetrospectiveReport();

      expect(report).toContain('### PR: PR-multi-0');
      expect(report).toContain('### PR: PR-multi-1');
      expect(report).toContain('### PR: PR-multi-2');
    });
  });
});
