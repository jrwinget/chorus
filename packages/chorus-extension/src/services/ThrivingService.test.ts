import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ThrivingService } from './ThrivingService';
import { TestDatabase, mockBallot, mockEvidence } from '../test/testUtils';
import { LocalDB } from '../storage/LocalDB';

describe('ThrivingService', () => {
  let testDb: TestDatabase;
  let db: LocalDB;
  let service: ThrivingService;

  beforeEach(async () => {
    testDb = new TestDatabase();
    db = testDb.db;
    await testDb.setup();
    service = new ThrivingService(db);
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  describe('runAutoDetection', () => {
    it('should detect ballot_submitted when ballots exist', async () => {
      const prRef = '#test-pr';
      await db.initializeChecklistForPR(prRef);
      await db.addBallot({ ...mockBallot, pr_reference: prRef });

      const detected = await service.runAutoDetection(prRef);

      // labs_se_1 has auto_detect_rule: {"type":"ballot_submitted"}
      expect(detected).toContain('labs_se_1');
    });

    it('should detect evidence_added when evidence exists', async () => {
      const prRef = '#test-pr';
      await db.initializeChecklistForPR(prRef);
      await db.saveEvidence({ ...mockEvidence, pr_reference: prRef });

      const detected = await service.runAutoDetection(prRef);

      // labs_ag_1 has auto_detect_rule: {"type":"evidence_added"}
      // labs_se_2 has auto_detect_rule: {"type":"evidence_added"}
      expect(detected).toContain('labs_ag_1');
      expect(detected).toContain('labs_se_2');
    });

    it('should return empty array when no data exists', async () => {
      const prRef = '#empty-pr';
      await db.initializeChecklistForPR(prRef);

      const detected = await service.runAutoDetection(prRef);

      expect(detected).toEqual([]);
    });

    it('should detect nudge_responded when nudge responses exist', async () => {
      const prRef = '#test-pr';
      await db.initializeChecklistForPR(prRef);

      const nudgeResponses = JSON.stringify({
        consideredAlternatives: false,
        mainRisk: 'Could break backwards compatibility',
        dissentingViews: '',
      });
      await db.addBallot({
        ...mockBallot,
        pr_reference: prRef,
        nudge_responses: nudgeResponses,
      });

      const detected = await service.runAutoDetection(prRef);

      // labs_ag_2 has auto_detect_rule: {"type":"nudge_responded"}
      expect(detected).toContain('labs_ag_2');
    });

    it('should detect retrospective_recorded when retrospectives exist', async () => {
      const prRef = '#test-pr';
      await db.initializeChecklistForPR(prRef);
      await db.recordRetrospective(prRef, 'manual', {
        what_went_wrong: 'Missed edge case',
        what_to_improve: 'Add more tests',
        bias_patterns: ['groupthink'],
      });

      const detected = await service.runAutoDetection(prRef);

      // labs_lc_4 has auto_detect_rule: {"type":"retrospective_recorded"}
      expect(detected).toContain('labs_lc_4');
    });

    it('should detect scheme_recorded when decision scheme exists', async () => {
      const prRef = '#test-pr';
      await db.initializeChecklistForPR(prRef);
      await db.recordDecisionScheme(prRef, 'consensus', 'Team agreed');

      const detected = await service.runAutoDetection(prRef);

      // labs_lc_3 has auto_detect_rule: {"type":"scheme_recorded"}
      expect(detected).toContain('labs_lc_3');
    });

    it('should not detect nudge_responded when nudge responses are empty/default', async () => {
      const prRef = '#test-pr';
      await db.initializeChecklistForPR(prRef);

      const emptyNudgeResponses = JSON.stringify({
        consideredAlternatives: false,
        mainRisk: '',
        dissentingViews: '',
      });
      await db.addBallot({
        ...mockBallot,
        pr_reference: prRef,
        nudge_responses: emptyNudgeResponses,
      });

      const detected = await service.runAutoDetection(prRef);

      // labs_ag_2 should NOT be detected since all nudge fields are empty/false
      expect(detected).not.toContain('labs_ag_2');
    });
  });

  describe('getChecklistForPR', () => {
    it('should return labs and trace items', async () => {
      const prRef = '#test-pr';

      const result = await service.getChecklistForPR(prRef);

      // 14 LABS items (4 learning_culture + 3 agency + 4 belonging + 3 self_efficacy)
      expect(result.labsItems).toHaveLength(14);
      // 5 TRACE items
      expect(result.traceItems).toHaveLength(5);
    });

    it('should be idempotent', async () => {
      const prRef = '#test-pr';

      const result1 = await service.getChecklistForPR(prRef);
      const result2 = await service.getChecklistForPR(prRef);

      expect(result1.labsItems).toHaveLength(result2.labsItems.length);
      expect(result1.traceItems).toHaveLength(result2.traceItems.length);

      // verify same item keys in both results
      const keys1 = result1.labsItems.map((i) => i.item_key).sort();
      const keys2 = result2.labsItems.map((i) => i.item_key).sort();
      expect(keys1).toEqual(keys2);
    });

    it('should include auto-detected keys', async () => {
      const prRef = '#test-pr';

      // add a ballot first so auto-detection picks it up
      await db.addBallot({ ...mockBallot, pr_reference: prRef });

      const result = await service.getChecklistForPR(prRef);

      // labs_se_1 should be auto-detected from the ballot
      expect(result.autoDetectedKeys).toContain('labs_se_1');

      // the corresponding item should be checked and auto_detected
      const se1 = result.labsItems.find((i) => i.item_key === 'labs_se_1');
      expect(se1).toBeDefined();
      expect(se1!.auto_detected).toBe(true);
      expect(se1!.checked).toBe(true);
    });
  });

  describe('computeAnalytics', () => {
    it('should return all four dimensions', async () => {
      const prRef = '#test-pr';
      await db.initializeChecklistForPR(prRef);

      const analytics = await service.computeAnalytics();

      expect(analytics.dimensions).toHaveLength(4);
      const dimensionNames = analytics.dimensions.map((d) => d.dimension);
      expect(dimensionNames).toContain('learning_culture');
      expect(dimensionNames).toContain('agency');
      expect(dimensionNames).toContain('belonging');
      expect(dimensionNames).toContain('self_efficacy');
    });

    it('should calculate completion rates correctly', async () => {
      const prRef = '#test-pr';
      await db.initializeChecklistForPR(prRef);

      // check all 4 learning_culture items
      await db.toggleChecklistItem(prRef, 'labs_lc_1', true);
      await db.toggleChecklistItem(prRef, 'labs_lc_2', true);
      await db.toggleChecklistItem(prRef, 'labs_lc_3', true);
      await db.toggleChecklistItem(prRef, 'labs_lc_4', true);

      const analytics = await service.computeAnalytics();

      const lcDim = analytics.dimensions.find((d) => d.dimension === 'learning_culture');
      expect(lcDim).toBeDefined();
      expect(lcDim!.completion_rate).toBe(1);

      // agency should be 0 since nothing was checked
      const agDim = analytics.dimensions.find((d) => d.dimension === 'agency');
      expect(agDim).toBeDefined();
      expect(agDim!.completion_rate).toBe(0);
    });

    it('should identify neglected dimensions', async () => {
      const prRef = '#test-pr';
      await db.initializeChecklistForPR(prRef);

      // leave all dimensions unchecked (completion_rate = 0, which is < 0.25)
      const analytics = await service.computeAnalytics();

      // all dimensions should be neglected since nothing is checked
      expect(analytics.neglected_dimensions).toContain('learning_culture');
      expect(analytics.neglected_dimensions).toContain('agency');
      expect(analytics.neglected_dimensions).toContain('belonging');
      expect(analytics.neglected_dimensions).toContain('self_efficacy');
    });

    it('should identify strong dimensions', async () => {
      const prRef = '#test-pr';
      await db.initializeChecklistForPR(prRef);

      // check all items in self_efficacy (3 items: labs_se_1, labs_se_2, labs_se_3)
      await db.toggleChecklistItem(prRef, 'labs_se_1', true);
      await db.toggleChecklistItem(prRef, 'labs_se_2', true);
      await db.toggleChecklistItem(prRef, 'labs_se_3', true);

      const analytics = await service.computeAnalytics();

      // self_efficacy should be strong (100% > 75%)
      expect(analytics.strong_dimensions).toContain('self_efficacy');
      // unchecked dimensions should not be strong
      expect(analytics.strong_dimensions).not.toContain('belonging');
    });

    it('should compute overall thriving score as average of dimensions', async () => {
      const prRef = '#test-pr';
      await db.initializeChecklistForPR(prRef);

      // check all learning_culture items (4/4 = 100%)
      await db.toggleChecklistItem(prRef, 'labs_lc_1', true);
      await db.toggleChecklistItem(prRef, 'labs_lc_2', true);
      await db.toggleChecklistItem(prRef, 'labs_lc_3', true);
      await db.toggleChecklistItem(prRef, 'labs_lc_4', true);

      // all others remain 0%
      // expected overall: (1 + 0 + 0 + 0) / 4 = 0.25
      const analytics = await service.computeAnalytics();

      expect(analytics.overall_thriving_score).toBeCloseTo(0.25, 2);
    });

    it('should compute trace completion', async () => {
      // initialize trace checklist by fetching it
      await db.getTraceChecklist();

      // check 2 of 5 trace items
      await db.toggleTraceItem('trace_t_1', true);
      await db.toggleTraceItem('trace_rg_1', true);

      const analytics = await service.computeAnalytics();

      // 2 out of 5 = 0.4
      expect(analytics.trace_completion).toBeCloseTo(0.4, 2);
    });
  });

  describe('generateReportSection', () => {
    it('should return markdown with all sections', async () => {
      const prRef = '#test-pr';
      await db.initializeChecklistForPR(prRef);

      const report = await service.generateReportSection();

      expect(report).toContain('## Developer Thriving Checklist');
      expect(report).toContain('### LABS Dimensions');
      expect(report).toContain('Learning Culture:');
      expect(report).toContain('Agency:');
      expect(report).toContain('Belonging:');
      expect(report).toContain('Self-Efficacy:');
      expect(report).toContain('### TRACE Principles');
      expect(report).toContain('### Overall Thriving Score:');
    });

    it('should show correct percentages', async () => {
      const prRef = '#test-pr';
      await db.initializeChecklistForPR(prRef);

      // check all 3 self_efficacy items
      await db.toggleChecklistItem(prRef, 'labs_se_1', true);
      await db.toggleChecklistItem(prRef, 'labs_se_2', true);
      await db.toggleChecklistItem(prRef, 'labs_se_3', true);

      const report = await service.generateReportSection();

      expect(report).toContain('Self-Efficacy: 100% completion');
      expect(report).toContain('Belonging: 0% completion');
    });

    it('should show trace count', async () => {
      await db.getTraceChecklist();
      await db.toggleTraceItem('trace_t_1', true);

      const report = await service.generateReportSection();

      expect(report).toContain('1 of 5 principles checked');
    });
  });

  describe('branch coverage: runAutoDetection with falsy nudge_responses', () => {
    it('should handle ballot with null nudge_responses', async () => {
      const prRef = '#null-nudge-pr';
      await db.initializeChecklistForPR(prRef);
      await db.addBallot({
        ...mockBallot,
        pr_reference: prRef,
        nudge_responses: undefined,
      });

      const detected = await service.runAutoDetection(prRef);

      // ballot_submitted should still be detected, but not nudge_responded
      expect(detected).toContain('labs_se_1');
      expect(detected).not.toContain('labs_ag_2');
    });

    it('should handle ballot with empty string nudge_responses', async () => {
      const prRef = '#empty-nudge-pr';
      await db.initializeChecklistForPR(prRef);
      await db.addBallot({
        ...mockBallot,
        pr_reference: prRef,
        nudge_responses: '',
      });

      const detected = await service.runAutoDetection(prRef);

      // ballot is there but nudge_responses is falsy — should not trigger nudge_responded
      expect(detected).toContain('labs_se_1');
      expect(detected).not.toContain('labs_ag_2');
    });
  });

  describe('branch coverage: runAutoDetection with invalid JSON', () => {
    it('should skip ballot with invalid nudge_responses JSON', async () => {
      const prRef = '#bad-json-pr';
      await db.initializeChecklistForPR(prRef);
      await db.addBallot({
        ...mockBallot,
        pr_reference: prRef,
        nudge_responses: '{invalid json!!!',
      });

      const detected = await service.runAutoDetection(prRef);

      // ballot_submitted should still be detected
      expect(detected).toContain('labs_se_1');
      // nudge_responded should NOT be detected because JSON parse failed
      expect(detected).not.toContain('labs_ag_2');
    });
  });

  describe('branch coverage: computeAnalytics with no data for a dimension', () => {
    it('should return 0 completion and insufficient_data trend for missing dimension', async () => {
      // do NOT initialize any checklist — rawAnalytics will be empty for all dimensions
      const analytics = await service.computeAnalytics();

      // all dimensions should have 0 completion rate and insufficient_data trend
      for (const dim of analytics.dimensions) {
        expect(dim.completion_rate).toBe(0);
        expect(dim.trend).toBe('insufficient_data');
        expect(dim.pr_count).toBe(0);
      }
    });
  });

  describe('branch coverage: computeAnalytics trend based on item count', () => {
    it('should show insufficient_data trend when pr_count < 5', async () => {
      const prRef = '#trend-test-pr';
      await db.initializeChecklistForPR(prRef);
      await db.toggleChecklistItem(prRef, 'labs_lc_1', true);

      const analytics = await service.computeAnalytics();

      const lcDim = analytics.dimensions.find((d) => d.dimension === 'learning_culture');
      expect(lcDim).toBeDefined();
      // 4 items in learning_culture, all initialized — item_count = 4 which is < 5
      expect(lcDim!.trend).toBe('insufficient_data');
    });

    it('should show stable trend when pr_count >= 5', async () => {
      // initialize checklists for multiple PRs so item_count >= 5
      for (let i = 0; i < 5; i++) {
        const prRef = `#bulk-pr-${i}`;
        await db.initializeChecklistForPR(prRef);
      }

      const analytics = await service.computeAnalytics();

      // learning_culture has 4 items per PR * 5 PRs = 20 items — well above 5
      const lcDim = analytics.dimensions.find((d) => d.dimension === 'learning_culture');
      expect(lcDim).toBeDefined();
      expect(lcDim!.trend).toBe('stable');
    });
  });

  describe('branch coverage: computeAnalytics trace completion with 0 items', () => {
    it('should return 0 trace completion when no trace items', async () => {
      // mock getTraceChecklist to return empty array to test the ternary
      vi.spyOn(db, 'getTraceChecklist').mockResolvedValue([]);

      const analytics = await service.computeAnalytics();

      expect(analytics.trace_completion).toBe(0);
    });
  });

  describe('branch coverage: computeAnalytics with filters', () => {
    it('should pass filters to getThrivingAnalytics', async () => {
      const prRef = '#filter-test-pr';
      await db.initializeChecklistForPR(prRef);

      const analytics = await service.computeAnalytics({
        pr_reference: prRef,
      });

      expect(analytics.dimensions).toHaveLength(4);
    });
  });

  describe('branch coverage: nudge_responded with consideredAlternatives true', () => {
    it('should detect nudge_responded when consideredAlternatives is true', async () => {
      const prRef = '#alt-pr';
      await db.initializeChecklistForPR(prRef);

      const nudgeResponses = JSON.stringify({
        consideredAlternatives: true,
        mainRisk: '',
        dissentingViews: '',
      });
      await db.addBallot({
        ...mockBallot,
        pr_reference: prRef,
        nudge_responses: nudgeResponses,
      });

      const detected = await service.runAutoDetection(prRef);

      expect(detected).toContain('labs_ag_2');
    });
  });

  describe('branch coverage: nudge_responded with dissentingViews set', () => {
    it('should detect nudge_responded when dissentingViews has value', async () => {
      const prRef = '#dissent-pr';
      await db.initializeChecklistForPR(prRef);

      const nudgeResponses = JSON.stringify({
        consideredAlternatives: false,
        mainRisk: '',
        dissentingViews: 'Some dissenting view',
      });
      await db.addBallot({
        ...mockBallot,
        pr_reference: prRef,
        nudge_responses: nudgeResponses,
      });

      const detected = await service.runAutoDetection(prRef);

      expect(detected).toContain('labs_ag_2');
    });
  });
});
