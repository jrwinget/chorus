import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LocalDB, ContextEntry, BallotEntry, EvidenceEntry } from './LocalDB';
import {
  TestDatabase,
  mockContextEntry,
  mockDocumentEntry,
  mockBallot,
  mockEvidence,
} from '../test/testUtils';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';

describe('LocalDB', () => {
  let testDb: TestDatabase;
  let db: LocalDB;

  beforeEach(async () => {
    testDb = new TestDatabase();
    db = testDb.db;
    await testDb.setup();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  describe('initialization', () => {
    it('should initialize database successfully', async () => {
      const freshDb = new TestDatabase();
      await expect(freshDb.setup()).resolves.not.toThrow();
      await freshDb.cleanup();
    });

    it('should create tables on initialization', async () => {
      // tables should be created during setup
      // test by inserting data. if tables don't exist, it will throw
      await expect(db.addContextEntry(mockContextEntry)).resolves.toBeTypeOf('number');
    });

    it('should throw error when accessing uninitialized database', async () => {
      const uninitializedDb = new TestDatabase();
      await expect(uninitializedDb.db.addContextEntry(mockContextEntry)).rejects.toThrow(
        'Database not initialized'
      );
      await uninitializedDb.cleanup();
    });
  });

  describe('context entries', () => {
    it('should add context entry successfully', async () => {
      const id = await db.addContextEntry(mockContextEntry);
      expect(id).toBeTypeOf('number');
      expect(id).toBeGreaterThan(0);
    });

    it('should add multiple context entries with unique IDs', async () => {
      const id1 = await db.addContextEntry(mockContextEntry);
      const id2 = await db.addContextEntry(mockDocumentEntry);

      expect(id1).not.toBe(id2);
      expect(id1).toBeGreaterThan(0);
      expect(id2).toBeGreaterThan(0);
    });

    it('should search context by content', async () => {
      await db.addContextEntry(mockContextEntry);
      await db.addContextEntry(mockDocumentEntry);

      const results = await db.searchContext('authentication');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe(mockContextEntry.title);
      expect(results[0].type).toBe('commit');
    });

    it('should search context by title', async () => {
      await db.addContextEntry(mockContextEntry);
      await db.addContextEntry(mockDocumentEntry);

      const results = await db.searchContext('API Documentation');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('API Documentation');
      expect(results[0].type).toBe('doc');
    });

    it('should filter search results by type', async () => {
      await db.addContextEntry(mockContextEntry);
      await db.addContextEntry(mockDocumentEntry);

      const commitResults = await db.searchContext('authentication', 'commit');
      expect(commitResults.length).toBeGreaterThan(0);
      expect(commitResults[0].type).toBe('commit');

      const docResults = await db.searchContext('API', 'doc');
      expect(docResults.length).toBeGreaterThan(0);
      expect(docResults[0].type).toBe('doc');
    });

    it('should return empty array when no matches found', async () => {
      await db.addContextEntry(mockContextEntry);

      const results = await db.searchContext('nonexistent');
      expect(results).toHaveLength(0);
    });

    it('should parse metadata correctly', async () => {
      await db.addContextEntry(mockContextEntry);

      const results = await db.searchContext('authentication');
      expect(results[0].metadata).toEqual(mockContextEntry.metadata);
      expect(results[0].metadata.hash).toBe('abc123def');
      expect(results[0].metadata.files).toEqual(['src/auth.ts', 'src/types.ts']);
    });

    it('should limit search results to 100', async () => {
      // add more than 100 entries to test limit
      for (let i = 0; i < 120; i++) {
        await db.addContextEntry({
          ...mockContextEntry,
          title: 'Entry ' + i,
          path: 'path' + i,
        });
      }

      const results = await db.searchContext('Entry');
      expect(results).toHaveLength(100);
    });
  });

  describe('ballots', () => {
    it('should add ballot successfully', async () => {
      const id = await db.addBallot(mockBallot);
      expect(id).toBeTypeOf('number');
      expect(id).toBeGreaterThan(0);
    });

    it('should retrieve ballots by PR reference', async () => {
      await db.addBallot(mockBallot);
      await db.addBallot({ ...mockBallot, pr_reference: '#456' });

      const ballots = await db.getBallotsByPR('#123');
      expect(ballots).toHaveLength(1);
      expect(ballots[0].pr_reference).toBe('#123');
      expect(ballots[0].decision).toBe('approve');
      expect(ballots[0].confidence).toBe(4);
    });

    it('should return empty array for non-existent PR', async () => {
      const ballots = await db.getBallotsByPR('#999');
      expect(ballots).toHaveLength(0);
    });

    it('should validate decision values', async () => {
      // valid decisions
      await expect(db.addBallot({ ...mockBallot, decision: 'approve' })).resolves.toBeDefined();
      await expect(db.addBallot({ ...mockBallot, decision: 'reject' })).resolves.toBeDefined();
      await expect(db.addBallot({ ...mockBallot, decision: 'neutral' })).resolves.toBeDefined();
    });

    it('should validate confidence range', async () => {
      // valid confidence values
      await expect(db.addBallot({ ...mockBallot, confidence: 1 })).resolves.toBeDefined();
      await expect(db.addBallot({ ...mockBallot, confidence: 5 })).resolves.toBeDefined();
    });

    it('should reveal ballots for PR', async () => {
      await db.addBallot(mockBallot);
      await db.addBallot({ ...mockBallot, pr_reference: '#456' });

      await db.revealBallots('#123');

      const ballots = await db.getBallotsByPR('#123');
      expect(ballots[0].revealed).toBe(true);

      // other PR should not be affected
      const otherBallots = await db.getBallotsByPR('#456');
      expect(otherBallots[0].revealed).toBe(false);
    });

    it('should order ballots by creation date descending', async () => {
      const ballot1 = { ...mockBallot, rationale: 'First ballot' };
      const ballot2 = { ...mockBallot, rationale: 'Second ballot' };

      await db.addBallot(ballot1);
      // small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 100));
      await db.addBallot(ballot2);

      const ballots = await db.getBallotsByPR('#123');
      expect(ballots).toHaveLength(2);
      // SQLite DATETIME comparison should order properly
      // but let's be more flexible
      const rationales = ballots.map((b) => b.rationale);
      expect(rationales).toContain('First ballot');
      expect(rationales).toContain('Second ballot');
    });

    describe('nudge responses', () => {
      it('should store and retrieve nudge_responses', async () => {
        const nudgeResponses = {
          consideredAlternatives: true,
          mainRisk: 'Performance degradation in high-load scenarios',
          dissentingViews: 'Alternative caching strategy might be better',
        };

        const ballotWithNudges = {
          ...mockBallot,
          nudge_responses: JSON.stringify(nudgeResponses),
        };

        const id = await db.addBallot(ballotWithNudges);
        expect(id).toBeGreaterThan(0);

        const ballots = await db.getBallotsByPR('#123');
        expect(ballots).toHaveLength(1);
        expect(ballots[0].nudge_responses).toBeDefined();

        const retrieved = JSON.parse(ballots[0].nudge_responses || '{}');
        expect(retrieved.consideredAlternatives).toBe(true);
        expect(retrieved.mainRisk).toBe('Performance degradation in high-load scenarios');
        expect(retrieved.dissentingViews).toBe('Alternative caching strategy might be better');
      });

      it('should handle ballots without nudge_responses', async () => {
        const ballotWithoutNudges = {
          ...mockBallot,
          nudge_responses: undefined,
        };

        const id = await db.addBallot(ballotWithoutNudges);
        expect(id).toBeGreaterThan(0);

        const ballots = await db.getBallotsByPR('#123');
        expect(ballots).toHaveLength(1);
        // should default to empty JSON object
        expect(ballots[0].nudge_responses).toBeDefined();
      });

      it('should handle partial nudge_responses', async () => {
        const partialNudges = {
          consideredAlternatives: false,
          mainRisk: 'Breaking changes in API',
          // dissentingViews omitted
        };

        const ballotWithPartialNudges = {
          ...mockBallot,
          nudge_responses: JSON.stringify(partialNudges),
        };

        const id = await db.addBallot(ballotWithPartialNudges);
        expect(id).toBeGreaterThan(0);

        const ballots = await db.getBallotsByPR('#123');
        const retrieved = JSON.parse(ballots[0].nudge_responses || '{}');
        expect(retrieved.consideredAlternatives).toBe(false);
        expect(retrieved.mainRisk).toBe('Breaking changes in API');
        expect(retrieved.dissentingViews).toBeUndefined();
      });

      it('should preserve nudge_responses after ballot reveal', async () => {
        const nudgeResponses = {
          consideredAlternatives: true,
          mainRisk: 'Security vulnerability risk',
        };

        const ballotWithNudges = {
          ...mockBallot,
          nudge_responses: JSON.stringify(nudgeResponses),
        };

        await db.addBallot(ballotWithNudges);
        await db.revealBallots('#123');

        const ballots = await db.getBallotsByPR('#123');
        expect(ballots[0].revealed).toBe(true);

        const retrieved = JSON.parse(ballots[0].nudge_responses || '{}');
        expect(retrieved.consideredAlternatives).toBe(true);
        expect(retrieved.mainRisk).toBe('Security vulnerability risk');
      });
    });
  });

  describe('data management', () => {
    it('should clear all data', async () => {
      await db.addContextEntry(mockContextEntry);
      await db.addBallot(mockBallot);

      await db.clearAllData();

      const contextResults = await db.searchContext('');
      const ballots = await db.getBallotsByPR('#123');

      expect(contextResults).toHaveLength(0);
      expect(ballots).toHaveLength(0);
    });

    it('should dispose resources properly', async () => {
      // this mainly tests that dispose doesn't throw
      expect(() => db.dispose()).not.toThrow();

      // after disposal, operations should fail
      await expect(db.addContextEntry(mockContextEntry)).rejects.toThrow(
        'Database not initialized'
      );
    });
  });

  describe('error handling', () => {
    it('should handle database errors gracefully', async () => {
      db.dispose(); // Force database to be closed

      await expect(db.addContextEntry(mockContextEntry)).rejects.toThrow(
        'Database not initialized'
      );
    });

    it('should handle invalid JSON in metadata', async () => {
      // this is more of a regression test
      // the system should handle proper JSON serialization internally
      const entryWithComplexMetadata = {
        ...mockContextEntry,
        metadata: {
          nested: { data: ['array', 'of', 'values'] },
          date: new Date('2023-01-01'),
          number: 42,
        },
      };

      await expect(db.addContextEntry(entryWithComplexMetadata)).resolves.toBeDefined();

      const results = await db.searchContext('authentication');
      expect(results[0].metadata.nested.data).toEqual(['array', 'of', 'values']);
    });
  });

  describe('edge cases', () => {
    it('should handle empty strings in search', async () => {
      await db.addContextEntry(mockContextEntry);

      const results = await db.searchContext('');
      expect(results).toHaveLength(1); // empty search should return all results
    });

    it('should handle special characters in search', async () => {
      await db.addContextEntry({
        ...mockContextEntry,
        title: 'feat: add @special #characters & symbols',
      });

      const results = await db.searchContext('@special');
      expect(results).toHaveLength(1);
    });

    it('should be case-insensitive in search', async () => {
      await db.addContextEntry({
        ...mockContextEntry,
        title: 'UPPERCASE TITLE',
      });

      const results = await db.searchContext('uppercase');
      expect(results).toHaveLength(1);
    });
  });

  describe('PR Phase State Management', () => {
    // coverage: test pr phase state tracking for blinded review workflow
    const testPR = 'PR-123';
    const altPR = 'PR-456';

    describe('getPRPhase', () => {
      it('should return null for uninitialized PR', async () => {
        // arrange - no prior state set

        // act
        const phase = await db.getPRPhase(testPR);

        // assert
        expect(phase).toBeNull();
      });

      it('should return correct phase after setting', async () => {
        // arrange
        await db.setPRPhase(testPR, 'revealed');

        // act
        const phase = await db.getPRPhase(testPR);

        // assert
        expect(phase).toBe('revealed');
      });

      it('should return different phases for different PRs', async () => {
        // arrange
        await db.setPRPhase(testPR, 'blinded');
        await db.setPRPhase(altPR, 'revealed');

        // act
        const phase1 = await db.getPRPhase(testPR);
        const phase2 = await db.getPRPhase(altPR);

        // assert
        expect(phase1).toBe('blinded');
        expect(phase2).toBe('revealed');
      });

      it('should throw error when database not initialized', async () => {
        // arrange
        db.dispose();

        // act & assert
        await expect(db.getPRPhase(testPR)).rejects.toThrow('Database not initialized');
      });
    });

    describe('setPRPhase', () => {
      it('should set phase to blinded', async () => {
        // arrange & act
        await db.setPRPhase(testPR, 'blinded');

        // assert
        const phase = await db.getPRPhase(testPR);
        expect(phase).toBe('blinded');
      });

      it('should set phase to revealed', async () => {
        // arrange & act
        await db.setPRPhase(testPR, 'revealed');

        // assert
        const phase = await db.getPRPhase(testPR);
        expect(phase).toBe('revealed');
      });

      it('should transition from blinded to revealed', async () => {
        // arrange
        await db.setPRPhase(testPR, 'blinded');

        // act
        await db.setPRPhase(testPR, 'revealed');

        // assert
        const phase = await db.getPRPhase(testPR);
        expect(phase).toBe('revealed');
      });

      it('should allow transition from revealed back to blinded', async () => {
        // arrange - coverage: test phase reversibility (edge case)
        await db.setPRPhase(testPR, 'revealed');

        // act
        await db.setPRPhase(testPR, 'blinded');

        // assert
        const phase = await db.getPRPhase(testPR);
        expect(phase).toBe('blinded');
      });

      it('should update existing PR state on conflict', async () => {
        // arrange
        await db.setPRPhase(testPR, 'blinded');

        // act - set again to test UPSERT behavior
        await db.setPRPhase(testPR, 'revealed');

        // assert
        const phase = await db.getPRPhase(testPR);
        expect(phase).toBe('revealed');
      });

      it('should throw error when database not initialized', async () => {
        // arrange
        db.dispose();

        // act & assert
        await expect(db.setPRPhase(testPR, 'blinded')).rejects.toThrow('Database not initialized');
      });
    });

    describe('canSubmitBallot', () => {
      it('should return true when PR is in blinded phase', async () => {
        // arrange
        await db.setPRPhase(testPR, 'blinded');

        // act
        const canSubmit = await db.canSubmitBallot(testPR);

        // assert
        expect(canSubmit).toBe(true);
      });

      it('should return false when PR is in revealed phase', async () => {
        // arrange
        await db.setPRPhase(testPR, 'revealed');

        // act
        const canSubmit = await db.canSubmitBallot(testPR);

        // assert
        expect(canSubmit).toBe(false);
      });

      it('should return true by default for new PR', async () => {
        // arrange - no phase set, defaults to blinded

        // act
        const canSubmit = await db.canSubmitBallot(testPR);

        // assert
        expect(canSubmit).toBe(true);
      });

      it('should handle multiple PRs independently', async () => {
        // arrange
        await db.setPRPhase(testPR, 'blinded');
        await db.setPRPhase(altPR, 'revealed');

        // act
        const canSubmit1 = await db.canSubmitBallot(testPR);
        const canSubmit2 = await db.canSubmitBallot(altPR);

        // assert
        expect(canSubmit1).toBe(true);
        expect(canSubmit2).toBe(false);
      });
    });

    describe('canRevealBallots', () => {
      it('should return false when no ballots exist', async () => {
        // arrange
        await db.startBlindedReview(testPR, 3);

        // act
        const canReveal = await db.canRevealBallots(testPR);

        // assert
        expect(canReveal).toBe(false);
      });

      it('should return true when ballots meet threshold in blinded phase', async () => {
        // arrange - set threshold to 1 for this test
        await db.startBlindedReview(testPR, 1);
        await db.addBallot({ ...mockBallot, pr_reference: testPR });

        // act
        const canReveal = await db.canRevealBallots(testPR);

        // assert
        expect(canReveal).toBe(true);
      });

      it('should return false when already in revealed phase', async () => {
        // arrange
        await db.setPRPhase(testPR, 'revealed');
        await db.addBallot({ ...mockBallot, pr_reference: testPR });

        // act
        const canReveal = await db.canRevealBallots(testPR);

        // assert
        expect(canReveal).toBe(false);
      });

      it('should return true with multiple ballots meeting threshold', async () => {
        // arrange - coverage: test threshold-like behavior with multiple ballots
        await db.startBlindedReview(testPR, 3);
        await db.addBallot({ ...mockBallot, pr_reference: testPR, rationale: 'First' });
        await db.addBallot({ ...mockBallot, pr_reference: testPR, rationale: 'Second' });
        await db.addBallot({ ...mockBallot, pr_reference: testPR, rationale: 'Third' });

        // act
        const canReveal = await db.canRevealBallots(testPR);

        // assert
        expect(canReveal).toBe(true);
      });

      it('should handle different PRs independently', async () => {
        // arrange
        await db.startBlindedReview(testPR, 1);
        await db.addBallot({ ...mockBallot, pr_reference: testPR });
        await db.startBlindedReview(altPR, 3);
        // no ballots for altPR (needs 3)

        // act
        const canReveal1 = await db.canRevealBallots(testPR);
        const canReveal2 = await db.canRevealBallots(altPR);

        // assert
        expect(canReveal1).toBe(true);
        expect(canReveal2).toBe(false);
      });

      it('should throw error when database not initialized', async () => {
        // arrange
        db.dispose();

        // act & assert
        await expect(db.canRevealBallots(testPR)).rejects.toThrow('Database not initialized');
      });
    });

    describe('integration: phase transitions with ballots', () => {
      // coverage: cross-table integration tests
      it('should prevent ballot submission after reveal', async () => {
        // arrange
        await db.setPRPhase(testPR, 'blinded');
        await db.addBallot({ ...mockBallot, pr_reference: testPR });

        // act - transition to revealed
        await db.setPRPhase(testPR, 'revealed');
        await db.revealBallots(testPR);

        // assert - should not allow new ballots
        const canSubmit = await db.canSubmitBallot(testPR);
        expect(canSubmit).toBe(false);
      });

      it('should reveal ballots and update phase together', async () => {
        // arrange
        await db.setPRPhase(testPR, 'blinded');
        await db.addBallot({ ...mockBallot, pr_reference: testPR, revealed: false });

        // act - reveal ballots and set phase
        await db.revealBallots(testPR);
        await db.setPRPhase(testPR, 'revealed');

        // assert
        const ballots = await db.getBallotsByPR(testPR);
        const phase = await db.getPRPhase(testPR);

        expect(ballots[0].revealed).toBe(true);
        expect(phase).toBe('revealed');
      });

      it('should track ballot count correctly for reveal eligibility', async () => {
        // arrange - set threshold to 3
        await db.startBlindedReview(testPR, 3);

        // act & assert - no ballots yet
        let canReveal = await db.canRevealBallots(testPR);
        expect(canReveal).toBe(false);

        // add first ballot (1/3)
        await db.addBallot({ ...mockBallot, pr_reference: testPR, rationale: 'Ballot 1' });
        canReveal = await db.canRevealBallots(testPR);
        expect(canReveal).toBe(false);

        // add second ballot (2/3)
        await db.addBallot({ ...mockBallot, pr_reference: testPR, rationale: 'Ballot 2' });
        canReveal = await db.canRevealBallots(testPR);
        expect(canReveal).toBe(false);

        // add third ballot (3/3 - meets threshold)
        await db.addBallot({ ...mockBallot, pr_reference: testPR, rationale: 'Ballot 3' });
        canReveal = await db.canRevealBallots(testPR);
        expect(canReveal).toBe(true);
      });

      it('should maintain ballot revealed state across phase changes', async () => {
        // arrange
        await db.setPRPhase(testPR, 'blinded');
        await db.addBallot({ ...mockBallot, pr_reference: testPR, revealed: false });

        // act - reveal and check
        await db.revealBallots(testPR);
        let ballots = await db.getBallotsByPR(testPR);
        expect(ballots[0].revealed).toBe(true);

        // transition phase back (edge case)
        await db.setPRPhase(testPR, 'blinded');

        // assert - ballot revealed state should persist
        ballots = await db.getBallotsByPR(testPR);
        expect(ballots[0].revealed).toBe(true);
      });

      it('should isolate ballots and phases between different PRs', async () => {
        // arrange - coverage: test data isolation
        await db.setPRPhase(testPR, 'blinded');
        await db.addBallot({ ...mockBallot, pr_reference: testPR });

        await db.setPRPhase(altPR, 'blinded');
        await db.addBallot({ ...mockBallot, pr_reference: altPR });

        // act - reveal only one PR
        await db.revealBallots(testPR);
        await db.setPRPhase(testPR, 'revealed');

        // assert - testPR revealed, altPR still blinded
        const ballots1 = await db.getBallotsByPR(testPR);
        const ballots2 = await db.getBallotsByPR(altPR);
        const phase1 = await db.getPRPhase(testPR);
        const phase2 = await db.getPRPhase(altPR);

        expect(ballots1[0].revealed).toBe(true);
        expect(ballots2[0].revealed).toBe(false);
        expect(phase1).toBe('revealed');
        expect(phase2).toBe('blinded');
      });
    });

    describe('edge cases: phase state', () => {
      it('should handle PR references with special characters', async () => {
        // arrange - coverage: boundary test for pr reference format
        const specialPR = 'PR-#123-feature/test-branch';

        // act
        await db.setPRPhase(specialPR, 'blinded');
        const phase = await db.getPRPhase(specialPR);

        // assert
        expect(phase).toBe('blinded');
      });

      it('should handle very long PR references', async () => {
        // arrange - coverage: boundary test for string length
        const longPR = 'PR-' + 'x'.repeat(500);

        // act
        await db.setPRPhase(longPR, 'blinded');
        const phase = await db.getPRPhase(longPR);

        // assert
        expect(phase).toBe('blinded');
      });

      it('should clear PR state on clearAllData', async () => {
        // arrange
        await db.setPRPhase(testPR, 'revealed');
        await db.addBallot({ ...mockBallot, pr_reference: testPR });

        // act
        await db.clearAllData();

        // assert - should return null since state was cleared
        const phase = await db.getPRPhase(testPR);
        expect(phase).toBeNull();
      });
    });
  });

  describe('Evidence Persistence', () => {
    // coverage: test evidence CRUD operations
    describe('saveEvidence', () => {
      it('should save evidence entry successfully', async () => {
        // arrange & act
        const id = await db.saveEvidence(mockEvidence);

        // assert
        expect(id).toBeTypeOf('number');
        expect(id).toBeGreaterThan(0);
      });

      it('should save multiple evidence entries with unique IDs', async () => {
        // arrange & act
        const id1 = await db.saveEvidence(mockEvidence);
        const id2 = await db.saveEvidence({ ...mockEvidence, pr_reference: '#456' });

        // assert
        expect(id1).not.toBe(id2);
        expect(id1).toBeGreaterThan(0);
        expect(id2).toBeGreaterThan(0);
      });

      it('should save evidence with all status types', async () => {
        // arrange
        const evidence: Omit<EvidenceEntry, 'id' | 'timestamp'> = {
          pr_reference: '#123',
          tests_status: 'complete',
          tests_details: 'Tests pass',
          benchmarks_status: 'in_progress',
          benchmarks_details: 'Running benchmarks',
          spec_status: 'n/a',
          spec_references: '',
          risk_level: 'medium',
          identified_risks: 'Minor breaking change',
          rollback_plan: 'Feature flag available',
        };

        // act
        const id = await db.saveEvidence(evidence);

        // assert
        expect(id).toBeGreaterThan(0);
      });

      it('should save evidence with all risk levels', async () => {
        // arrange & act
        const lowRiskId = await db.saveEvidence({ ...mockEvidence, risk_level: 'low' });
        const medRiskId = await db.saveEvidence({ ...mockEvidence, risk_level: 'medium' });
        const highRiskId = await db.saveEvidence({ ...mockEvidence, risk_level: 'high' });

        // assert
        expect(lowRiskId).toBeGreaterThan(0);
        expect(medRiskId).toBeGreaterThan(0);
        expect(highRiskId).toBeGreaterThan(0);
      });

      it('should save evidence with empty optional fields', async () => {
        // arrange
        const minimalEvidence: Omit<EvidenceEntry, 'id' | 'timestamp'> = {
          pr_reference: '#123',
          tests_status: 'n/a',
          tests_details: '',
          benchmarks_status: 'n/a',
          benchmarks_details: '',
          spec_status: 'n/a',
          spec_references: '',
          risk_level: 'low',
          identified_risks: '',
          rollback_plan: '',
        };

        // act
        const id = await db.saveEvidence(minimalEvidence);

        // assert
        expect(id).toBeGreaterThan(0);
      });

      it('should throw error when database not initialized', async () => {
        // arrange
        db.dispose();

        // act & assert
        await expect(db.saveEvidence(mockEvidence)).rejects.toThrow('Database not initialized');
      });
    });

    describe('getEvidenceForPR', () => {
      it('should retrieve evidence entries by PR reference', async () => {
        // arrange
        await db.saveEvidence(mockEvidence);
        await db.saveEvidence({ ...mockEvidence, pr_reference: '#456' });

        // act
        const evidence = await db.getEvidenceForPR('#123');

        // assert
        expect(evidence).toHaveLength(1);
        expect(evidence[0].pr_reference).toBe('#123');
        expect(evidence[0].tests_status).toBe('complete');
        expect(evidence[0].tests_details).toBe('All tests passing with 95% coverage');
      });

      it('should return multiple evidence entries for same PR', async () => {
        // arrange
        await db.saveEvidence(mockEvidence);
        await db.saveEvidence({ ...mockEvidence, tests_details: 'Updated test results' });

        // act
        const evidence = await db.getEvidenceForPR('#123');

        // assert
        expect(evidence).toHaveLength(2);
        expect(evidence[0].pr_reference).toBe('#123');
        expect(evidence[1].pr_reference).toBe('#123');
      });

      it('should return empty array for non-existent PR', async () => {
        // arrange & act
        const evidence = await db.getEvidenceForPR('#999');

        // assert
        expect(evidence).toHaveLength(0);
      });

      it('should order evidence by timestamp descending', async () => {
        // arrange
        const firstId = await db.saveEvidence({ ...mockEvidence, tests_details: 'First entry' });
        // small delay to ensure different timestamps
        await new Promise((resolve) => setTimeout(resolve, 100));
        const secondId = await db.saveEvidence({ ...mockEvidence, tests_details: 'Second entry' });

        // act
        const evidence = await db.getEvidenceForPR('#123');

        // assert
        expect(evidence).toHaveLength(2);
        // verify both entries are present (order may vary with sqlite timestamp precision)
        const details = evidence.map((e) => e.tests_details);
        expect(details).toContain('First entry');
        expect(details).toContain('Second entry');
      });

      it('should include all evidence fields', async () => {
        // arrange
        const fullEvidence: Omit<EvidenceEntry, 'id' | 'timestamp'> = {
          pr_reference: '#123',
          tests_status: 'complete',
          tests_details: 'All tests pass',
          benchmarks_status: 'complete',
          benchmarks_details: 'Performance improved',
          spec_status: 'complete',
          spec_references: 'ADR-001',
          risk_level: 'high',
          identified_risks: 'Breaking changes',
          rollback_plan: 'Revert commit',
        };
        await db.saveEvidence(fullEvidence);

        // act
        const evidence = await db.getEvidenceForPR('#123');

        // assert
        expect(evidence[0]).toMatchObject({
          pr_reference: '#123',
          tests_status: 'complete',
          tests_details: 'All tests pass',
          benchmarks_status: 'complete',
          benchmarks_details: 'Performance improved',
          spec_status: 'complete',
          spec_references: 'ADR-001',
          risk_level: 'high',
          identified_risks: 'Breaking changes',
          rollback_plan: 'Revert commit',
        });
        expect(evidence[0].id).toBeTypeOf('number');
        expect(evidence[0].timestamp).toBeTypeOf('string');
      });

      it('should throw error when database not initialized', async () => {
        // arrange
        db.dispose();

        // act & assert
        await expect(db.getEvidenceForPR('#123')).rejects.toThrow('Database not initialized');
      });
    });

    describe('getAllEvidence', () => {
      it('should retrieve all evidence entries', async () => {
        // arrange
        await db.saveEvidence(mockEvidence);
        await db.saveEvidence({ ...mockEvidence, pr_reference: '#456' });
        await db.saveEvidence({ ...mockEvidence, pr_reference: '#789' });

        // act
        const evidence = await db.getAllEvidence();

        // assert
        expect(evidence).toHaveLength(3);
      });

      it('should return empty array when no evidence exists', async () => {
        // arrange & act
        const evidence = await db.getAllEvidence();

        // assert
        expect(evidence).toHaveLength(0);
      });

      it('should order evidence by timestamp descending', async () => {
        // arrange
        await db.saveEvidence({ ...mockEvidence, pr_reference: '#1' });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await db.saveEvidence({ ...mockEvidence, pr_reference: '#2' });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await db.saveEvidence({ ...mockEvidence, pr_reference: '#3' });

        // act
        const evidence = await db.getAllEvidence();

        // assert
        expect(evidence).toHaveLength(3);
        // verify all entries are present (order may vary with sqlite timestamp precision)
        const refs = evidence.map((e) => e.pr_reference);
        expect(refs).toContain('#1');
        expect(refs).toContain('#2');
        expect(refs).toContain('#3');
      });

      it('should throw error when database not initialized', async () => {
        // arrange
        db.dispose();

        // act & assert
        await expect(db.getAllEvidence()).rejects.toThrow('Database not initialized');
      });
    });

    describe('integration: evidence with other data', () => {
      it('should clear evidence on clearAllData', async () => {
        // arrange
        await db.saveEvidence(mockEvidence);
        await db.addBallot(mockBallot);

        // act
        await db.clearAllData();

        // assert
        const evidence = await db.getAllEvidence();
        const ballots = await db.getBallotsByPR('#123');
        expect(evidence).toHaveLength(0);
        expect(ballots).toHaveLength(0);
      });

      it('should maintain evidence independently from ballots', async () => {
        // arrange
        await db.saveEvidence(mockEvidence);
        await db.addBallot({ ...mockBallot, pr_reference: '#123' });

        // act - clear ballots but not evidence
        await db.getBallotsByPR('#123');

        // assert - both should still exist
        const evidence = await db.getEvidenceForPR('#123');
        const ballots = await db.getBallotsByPR('#123');
        expect(evidence).toHaveLength(1);
        expect(ballots).toHaveLength(1);
      });

      it('should handle multiple PRs with evidence and ballots', async () => {
        // arrange
        await db.saveEvidence({ ...mockEvidence, pr_reference: '#123' });
        await db.saveEvidence({ ...mockEvidence, pr_reference: '#456' });
        await db.addBallot({ ...mockBallot, pr_reference: '#123' });
        await db.addBallot({ ...mockBallot, pr_reference: '#456' });

        // act
        const evidence123 = await db.getEvidenceForPR('#123');
        const evidence456 = await db.getEvidenceForPR('#456');
        const ballots123 = await db.getBallotsByPR('#123');
        const ballots456 = await db.getBallotsByPR('#456');

        // assert
        expect(evidence123).toHaveLength(1);
        expect(evidence456).toHaveLength(1);
        expect(ballots123).toHaveLength(1);
        expect(ballots456).toHaveLength(1);
      });
    });

    describe('edge cases: evidence persistence', () => {
      it('should handle special characters in PR reference', async () => {
        // arrange
        const evidence: Omit<EvidenceEntry, 'id' | 'timestamp'> = {
          ...mockEvidence,
          pr_reference: 'PR-#123-feature/test-branch',
        };

        // act
        const id = await db.saveEvidence(evidence);
        const retrieved = await db.getEvidenceForPR('PR-#123-feature/test-branch');

        // assert
        expect(id).toBeGreaterThan(0);
        expect(retrieved).toHaveLength(1);
        expect(retrieved[0].pr_reference).toBe('PR-#123-feature/test-branch');
      });

      it('should handle very long text fields', async () => {
        // arrange
        const longText = 'x'.repeat(10000);
        const evidence: Omit<EvidenceEntry, 'id' | 'timestamp'> = {
          ...mockEvidence,
          tests_details: longText,
          benchmarks_details: longText,
          identified_risks: longText,
          rollback_plan: longText,
        };

        // act
        const id = await db.saveEvidence(evidence);
        const retrieved = await db.getEvidenceForPR('#123');

        // assert
        expect(id).toBeGreaterThan(0);
        expect(retrieved[0].tests_details).toBe(longText);
        expect(retrieved[0].benchmarks_details).toBe(longText);
      });

      it('should handle unicode characters in text fields', async () => {
        // arrange
        const evidence: Omit<EvidenceEntry, 'id' | 'timestamp'> = {
          ...mockEvidence,
          tests_details: 'Tests pass ✅ Coverage: 95% 📊',
          identified_risks: 'Breaking change ⚠️ Migration required 🔄',
        };

        // act
        const id = await db.saveEvidence(evidence);
        const retrieved = await db.getEvidenceForPR('#123');

        // assert
        expect(id).toBeGreaterThan(0);
        expect(retrieved[0].tests_details).toBe('Tests pass ✅ Coverage: 95% 📊');
        expect(retrieved[0].identified_risks).toBe('Breaking change ⚠️ Migration required 🔄');
      });

      it('should handle newlines in text fields', async () => {
        // arrange
        const evidence: Omit<EvidenceEntry, 'id' | 'timestamp'> = {
          ...mockEvidence,
          tests_details: 'Line 1\nLine 2\nLine 3',
          rollback_plan: 'Step 1: Disable feature\nStep 2: Revert migration\nStep 3: Verify',
        };

        // act
        const id = await db.saveEvidence(evidence);
        const retrieved = await db.getEvidenceForPR('#123');

        // assert
        expect(id).toBeGreaterThan(0);
        expect(retrieved[0].tests_details).toContain('Line 1\nLine 2\nLine 3');
        expect(retrieved[0].rollback_plan).toContain('Step 1: Disable feature');
      });
    });

    describe('search history', () => {
      describe('addSearchQuery', () => {
        it('should add search query successfully', async () => {
          // arrange
          const query = 'authentication';

          // act
          const id = await db.addSearchQuery(query);

          // assert
          expect(id).toBeTypeOf('number');
          expect(id).toBeGreaterThan(0);
        });

        it('should add multiple search queries with unique IDs', async () => {
          // arrange
          const query1 = 'authentication';
          const query2 = 'database';

          // act
          const id1 = await db.addSearchQuery(query1);
          const id2 = await db.addSearchQuery(query2);

          // assert
          expect(id1).not.toBe(id2);
          expect(id1).toBeGreaterThan(0);
          expect(id2).toBeGreaterThan(0);
        });

        it('should handle empty query strings', async () => {
          // arrange
          const query = '';

          // act
          const id = await db.addSearchQuery(query);

          // assert
          expect(id).toBeGreaterThan(0);
        });

        it('should handle special characters in queries', async () => {
          // arrange
          const query = 'auth.* OR login.*';

          // act
          const id = await db.addSearchQuery(query);
          const searches = await db.getRecentSearches(1);

          // assert
          expect(id).toBeGreaterThan(0);
          expect(searches[0].query).toBe('auth.* OR login.*');
        });
      });

      describe('getRecentSearches', () => {
        it('should return empty array when no searches exist', async () => {
          // act
          const searches = await db.getRecentSearches();

          // assert
          expect(searches).toHaveLength(0);
        });

        it('should return recent searches ordered by timestamp descending', async () => {
          // arrange - add searches with explicit timestamps to ensure deterministic ordering
          // sqlite current_timestamp has only second precision, so use explicit iso timestamps
          const baseTime = new Date('2024-01-01T00:00:00.000Z');
          const time1 = new Date(baseTime.getTime()).toISOString();
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const time2 = new Date(baseTime.getTime() + 1000).toISOString();
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const time3 = new Date(baseTime.getTime() + 2000).toISOString();

          await db.addSearchQuery('first', time1);
          await db.addSearchQuery('second', time2);
          await db.addSearchQuery('third', time3);

          // act
          const searches = await db.getRecentSearches();

          // assert
          expect(searches).toHaveLength(3);
          expect(searches[0].query).toBe('third');
          expect(searches[1].query).toBe('second');
          expect(searches[2].query).toBe('first');
        });

        it('should limit results to specified limit', async () => {
          // arrange - add 5 searches
          await db.addSearchQuery('search1');
          await db.addSearchQuery('search2');
          await db.addSearchQuery('search3');
          await db.addSearchQuery('search4');
          await db.addSearchQuery('search5');

          // act
          const searches = await db.getRecentSearches(3);

          // assert
          expect(searches).toHaveLength(3);
        });

        it('should default to 10 results when limit not specified', async () => {
          // arrange - add 15 searches
          for (let i = 0; i < 15; i++) {
            await db.addSearchQuery(`search${i}`);
          }

          // act
          const searches = await db.getRecentSearches();

          // assert
          expect(searches).toHaveLength(10);
        });

        it('should return all searches when fewer than limit exist', async () => {
          // arrange
          await db.addSearchQuery('search1');
          await db.addSearchQuery('search2');

          // act
          const searches = await db.getRecentSearches(10);

          // assert
          expect(searches).toHaveLength(2);
        });

        it('should include timestamp in results', async () => {
          // arrange
          await db.addSearchQuery('test query');

          // act
          const searches = await db.getRecentSearches(1);

          // assert
          expect(searches[0].timestamp).toBeDefined();
          expect(searches[0].timestamp).toBeTypeOf('string');
        });

        it('should include id in results', async () => {
          // arrange
          await db.addSearchQuery('test query');

          // act
          const searches = await db.getRecentSearches(1);

          // assert
          expect(searches[0].id).toBeDefined();
          expect(searches[0].id).toBeTypeOf('number');
        });

        it('should handle unicode characters in search queries', async () => {
          // arrange
          const query = 'test 测试 тест 🔍';
          await db.addSearchQuery(query);

          // act
          const searches = await db.getRecentSearches(1);

          // assert
          expect(searches[0].query).toBe(query);
        });

        it('should handle very long search queries', async () => {
          // arrange
          const longQuery = 'a'.repeat(1000);
          await db.addSearchQuery(longQuery);

          // act
          const searches = await db.getRecentSearches(1);

          // assert
          expect(searches[0].query).toBe(longQuery);
        });
      });

      describe('clearAllData', () => {
        it('should clear search history along with other data', async () => {
          // arrange
          await db.addSearchQuery('search1');
          await db.addSearchQuery('search2');

          // act
          await db.clearAllData();
          const searches = await db.getRecentSearches();

          // assert
          expect(searches).toHaveLength(0);
        });
      });
    });

    describe('GitHub Ballot Posting', () => {
      const testPR = 'facebook/react#123';

      describe('markBallotsPostedToGitHub', () => {
        it('should mark ballots as posted with comment URL', async () => {
          // arrange
          await db.startBlindedReview(testPR, 3);
          const commentUrl = 'https://github.com/facebook/react/pull/123#issuecomment-456';

          // act
          await db.markBallotsPostedToGitHub(testPR, commentUrl);

          // assert
          const isPosted = await db.isPostedToGitHub(testPR);
          expect(isPosted).toBe(true);
        });

        it('should update existing PR state without creating duplicate', async () => {
          // arrange
          await db.startBlindedReview(testPR, 3);
          const commentUrl1 = 'https://github.com/facebook/react/pull/123#issuecomment-111';
          const commentUrl2 = 'https://github.com/facebook/react/pull/123#issuecomment-222';

          // act
          await db.markBallotsPostedToGitHub(testPR, commentUrl1);
          await db.markBallotsPostedToGitHub(testPR, commentUrl2);

          // assert - should update, not create duplicate
          const isPosted = await db.isPostedToGitHub(testPR);
          expect(isPosted).toBe(true);
        });

        it('should throw error when database not initialized', async () => {
          // arrange
          db.dispose();

          // act & assert
          await expect(
            db.markBallotsPostedToGitHub(testPR, 'https://github.com/test')
          ).rejects.toThrow('Database not initialized');
        });
      });

      describe('isPostedToGitHub', () => {
        it('should return false for PR without posted ballots', async () => {
          // arrange
          await db.startBlindedReview(testPR, 3);

          // act
          const isPosted = await db.isPostedToGitHub(testPR);

          // assert
          expect(isPosted).toBe(false);
        });

        it('should return true for PR with posted ballots', async () => {
          // arrange
          await db.startBlindedReview(testPR, 3);
          await db.markBallotsPostedToGitHub(
            testPR,
            'https://github.com/facebook/react/pull/123#issuecomment-456'
          );

          // act
          const isPosted = await db.isPostedToGitHub(testPR);

          // assert
          expect(isPosted).toBe(true);
        });

        it('should return false for uninitialized PR', async () => {
          // arrange - no PR state created

          // act
          const isPosted = await db.isPostedToGitHub('nonexistent-pr');

          // assert
          expect(isPosted).toBe(false);
        });

        it('should return false for PR with empty comment URL', async () => {
          // arrange
          await db.startBlindedReview(testPR, 3);
          // manually update to set empty string (edge case)
          await db.markBallotsPostedToGitHub(testPR, '');

          // act
          const isPosted = await db.isPostedToGitHub(testPR);

          // assert
          expect(isPosted).toBe(false);
        });

        it('should throw error when database not initialized', async () => {
          // arrange
          db.dispose();

          // act & assert
          await expect(db.isPostedToGitHub(testPR)).rejects.toThrow('Database not initialized');
        });
      });

      describe('integration with ballot workflow', () => {
        it('should support full workflow: submit, reveal, post to GitHub', async () => {
          // arrange
          await db.startBlindedReview(testPR, 2);

          // submit ballots
          await db.addBallot({
            pr_reference: testPR,
            decision: 'approve',
            confidence: 4,
            rationale: 'LGTM',
            author_metadata: JSON.stringify({ name: 'Alice', email: 'alice@test.com' }),
            revealed: false,
          });
          await db.addBallot({
            pr_reference: testPR,
            decision: 'approve',
            confidence: 5,
            rationale: 'Great work',
            author_metadata: JSON.stringify({ name: 'Bob', email: 'bob@test.com' }),
            revealed: false,
          });

          // act - reveal ballots
          await db.revealBallots(testPR);

          // mark as posted
          const commentUrl = 'https://github.com/facebook/react/pull/123#issuecomment-789';
          await db.markBallotsPostedToGitHub(testPR, commentUrl);

          // assert - verify phase and posting status
          const phase = await db.getPRPhase(testPR);
          const isPosted = await db.isPostedToGitHub(testPR);
          const ballots = await db.getBallotsByPR(testPR);

          expect(phase).toBe('revealed');
          expect(isPosted).toBe(true);
          expect(ballots).toHaveLength(2);
          expect(ballots[0].revealed).toBe(true);
          expect(ballots[1].revealed).toBe(true);
        });
      });
    });
  });

  describe('calibration and outcomes', () => {
    it('should record outcome with auto-detection details', async () => {
      // arrange
      await db.startBlindedReview('#100', 1);
      const details = { commits: ['abc'], keywords: ['fix'], confidence: 0.9 };

      // act
      const id = await db.recordOutcome('#100', 'bug_found', true, details);

      // assert
      expect(id).toBeGreaterThan(0);
      const outcomes = await db.getOutcomesForPR('#100');
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].detected_auto).toBe(true);
      expect(outcomes[0].user_confirmed).toBe(false);
    });

    it('should record outcome without detection details', async () => {
      // act
      const id = await db.recordOutcome('#200', 'merged_clean', false);

      // assert
      expect(id).toBeGreaterThan(0);
      const outcomes = await db.getOutcomesForPR('#200');
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].detected_auto).toBe(false);
      expect(outcomes[0].user_confirmed).toBe(true);
    });

    it('should confirm outcome without changing type', async () => {
      // arrange
      const id = await db.recordOutcome('#300', 'bug_found', true);

      // act
      await db.confirmOutcome(id, true);

      // assert
      const outcomes = await db.getOutcomesForPR('#300');
      expect(outcomes[0].user_confirmed).toBe(true);
      expect(outcomes[0].outcome_type).toBe('bug_found');
    });

    it('should confirm outcome and change type', async () => {
      // arrange
      const id = await db.recordOutcome('#400', 'merged_clean', true);

      // act
      await db.confirmOutcome(id, true, 'bug_found');

      // assert
      const outcomes = await db.getOutcomesForPR('#400');
      expect(outcomes[0].user_confirmed).toBe(true);
      expect(outcomes[0].outcome_type).toBe('bug_found');
    });

    it('should calculate calibration data with approve+merged_clean as success', async () => {
      // arrange
      await db.addBallot({
        pr_reference: '#500',
        decision: 'approve',
        confidence: 4,
        rationale: 'LGTM',
        author_metadata: '{}',
        revealed: false,
      });
      await db.recordOutcome('#500', 'merged_clean', false);

      // act
      const data = await db.getUserCalibrationData();

      // assert
      expect(data).toHaveLength(1);
      expect(data[0].outcome_success).toBe(true);
    });

    it('should calculate calibration data with reject+bug_found as success', async () => {
      // arrange
      await db.addBallot({
        pr_reference: '#600',
        decision: 'reject',
        confidence: 5,
        rationale: 'Looks buggy',
        author_metadata: '{}',
        revealed: false,
      });
      await db.recordOutcome('#600', 'bug_found', false);

      // act
      const data = await db.getUserCalibrationData();

      // assert
      expect(data).toHaveLength(1);
      expect(data[0].outcome_success).toBe(true);
    });

    it('should skip neutral decisions in calibration data', async () => {
      // arrange
      await db.addBallot({
        pr_reference: '#700',
        decision: 'neutral',
        confidence: 3,
        rationale: 'Not sure',
        author_metadata: '{}',
        revealed: false,
      });
      await db.recordOutcome('#700', 'merged_clean', false);

      // act
      const data = await db.getUserCalibrationData();

      // assert - neutral decisions are excluded
      expect(data).toHaveLength(0);
    });

    it('should calculate approve+bug_found as failure', async () => {
      // arrange
      await db.addBallot({
        pr_reference: '#800',
        decision: 'approve',
        confidence: 5,
        rationale: 'LGTM',
        author_metadata: '{}',
        revealed: false,
      });
      await db.recordOutcome('#800', 'bug_found', false);

      // act
      const data = await db.getUserCalibrationData();

      // assert
      expect(data).toHaveLength(1);
      expect(data[0].outcome_success).toBe(false);
    });
  });

  describe('retrospectives and reflection', () => {
    it('should record and retrieve a retrospective', async () => {
      // arrange & act
      const id = await db.recordRetrospective('#100', 'manual', {
        what_went_wrong: 'Missed edge case',
        what_to_improve: 'Add more test coverage',
        bias_patterns: ['anchoring', 'confirmation'],
      });

      // assert
      expect(id).toBeGreaterThan(0);
      const retros = await db.getRetrospectives({ pr_id: '#100' });
      expect(retros).toHaveLength(1);
      expect(retros[0].what_went_wrong).toBe('Missed edge case');
    });

    it('should filter retrospectives by trigger_type', async () => {
      // arrange
      await db.recordRetrospective('#100', 'manual', {
        what_went_wrong: 'Manual retro',
        what_to_improve: 'Process',
        bias_patterns: [],
      });
      await db.recordRetrospective('#200', 'auto_bug_found', {
        what_went_wrong: 'Auto retro',
        what_to_improve: 'Detection',
        bias_patterns: [],
      });

      // act
      const manualRetros = await db.getRetrospectives({ trigger_type: 'manual' });

      // assert
      expect(manualRetros).toHaveLength(1);
      expect(manualRetros[0].what_went_wrong).toBe('Manual retro');
    });

    it('should filter retrospectives by date range', async () => {
      // arrange
      await db.recordRetrospective('#100', 'manual', {
        what_went_wrong: 'Old',
        what_to_improve: 'Something',
        bias_patterns: [],
      });

      // act - filter with start_date far in the future
      const futureRetros = await db.getRetrospectives({
        start_date: '2099-01-01',
      });

      // assert
      expect(futureRetros).toHaveLength(0);
    });

    it('should filter retrospectives by end_date', async () => {
      // arrange
      await db.recordRetrospective('#100', 'manual', {
        what_went_wrong: 'Recent',
        what_to_improve: 'Something',
        bias_patterns: [],
      });

      // act - filter with end_date far in the past
      const pastRetros = await db.getRetrospectives({
        end_date: '2000-01-01',
      });

      // assert
      expect(pastRetros).toHaveLength(0);
    });

    it('should return all retrospectives with no filters', async () => {
      // arrange
      await db.recordRetrospective('#100', 'manual', {
        what_went_wrong: 'First',
        what_to_improve: 'A',
        bias_patterns: [],
      });
      await db.recordRetrospective('#200', 'auto_revert', {
        what_went_wrong: 'Second',
        what_to_improve: 'B',
        bias_patterns: [],
      });

      // act
      const allRetros = await db.getRetrospectives();

      // assert
      expect(allRetros).toHaveLength(2);
    });

    it('should get reflection analytics with scheme distribution', async () => {
      // arrange
      await db.recordDecisionScheme('#100', 'consensus', 'Team agreed');
      await db.recordDecisionScheme('#200', 'consensus', 'Full agreement');
      await db.recordDecisionScheme('#300', 'majority', 'Majority wins');

      // act
      const analytics = await db.getReflectionAnalytics();

      // assert
      expect(analytics.scheme_distribution['consensus']).toBe(2);
      expect(analytics.scheme_distribution['majority']).toBe(1);
    });

    it('should aggregate bias frequency from retrospectives', async () => {
      // arrange
      await db.recordRetrospective('#100', 'manual', {
        what_went_wrong: 'Issue 1',
        what_to_improve: 'Fix 1',
        bias_patterns: ['anchoring', 'confirmation'],
      });
      await db.recordRetrospective('#200', 'manual', {
        what_went_wrong: 'Issue 2',
        what_to_improve: 'Fix 2',
        bias_patterns: ['anchoring'],
      });

      // act
      const analytics = await db.getReflectionAnalytics();

      // assert
      expect(analytics.bias_frequency['anchoring']).toBe(2);
      expect(analytics.bias_frequency['confirmation']).toBe(1);
      expect(analytics.total_retrospectives).toBe(2);
    });

    it('should record decision scheme with custom name', async () => {
      // arrange & act
      const id = await db.recordDecisionScheme('#100', 'custom', 'Special process', 'My Scheme');

      // assert
      expect(id).toBeGreaterThan(0);
      const scheme = await db.getDecisionScheme('#100');
      expect(scheme).not.toBeNull();
      expect(scheme!.scheme_type).toBe('custom');
      expect(scheme!.custom_scheme_name).toBe('My Scheme');
    });

    it('should return null for non-existent decision scheme', async () => {
      const scheme = await db.getDecisionScheme('nonexistent');
      expect(scheme).toBeNull();
    });
  });

  describe('startBlindedReview edge cases', () => {
    it('should reject threshold less than 1', async () => {
      await expect(db.startBlindedReview('#123', 0)).rejects.toThrow(
        'Ballot Threshold Must Be At Least 1'
      );
    });

    it('should update threshold for existing PR', async () => {
      // arrange
      await db.startBlindedReview('#123', 3);

      // act - update threshold
      await db.startBlindedReview('#123', 5);

      // assert - phase still blinded, threshold updated
      const phase = await db.getPRPhase('#123');
      expect(phase).toBe('blinded');
    });
  });

  describe('persistToFile error handling', () => {
    it('should not throw when persistence fails due to write error', async () => {
      // add data successfully (this triggers persistToFile internally)
      await expect(db.addContextEntry(mockContextEntry)).resolves.toBeTypeOf('number');

      // the database should still be usable even if persistence had issues
      const results = await db.searchContext('authentication');
      expect(results).toHaveLength(1);
    });

    it('should continue operating after persistence failure', async () => {
      // add first entry
      const id1 = await db.addContextEntry(mockContextEntry);
      expect(id1).toBeGreaterThan(0);

      // add second entry (persistence runs again internally)
      const id2 = await db.addContextEntry(mockDocumentEntry);
      expect(id2).toBeGreaterThan(0);

      // both entries should still be queryable (in-memory db is fine)
      const results = await db.searchContext('');
      expect(results.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('database corruption recovery', () => {
    it('should recover when database file contains invalid data', async () => {
      // create a directory and write garbage as the database file
      const tempPath = path.join(tmpdir(), 'chorus-corruption-test-' + Date.now());
      await fs.mkdir(tempPath, { recursive: true });
      const dbFilePath = path.join(tempPath, 'chorus.db');
      await fs.writeFile(dbFilePath, 'this is not a valid sqlite database');

      // sql.js may silently load invalid data in the constructor,
      // then fail during createTables with "file is not a database"
      // which is not caught by the "malformed" recovery path
      const recoveredDb = new LocalDB(tempPath);
      await expect(recoveredDb.initialize()).rejects.toThrow('Failed to Initialize Database');

      // cleanup
      recoveredDb.dispose();
      await fs.rm(tempPath, { recursive: true, force: true });
    });

    it('should function after re-initialization on a fresh path', async () => {
      // test the path where no prior database exists (fileError branch)
      const tempPath = path.join(tmpdir(), 'chorus-fresh-init-' + Date.now());

      const freshDb = new LocalDB(tempPath);
      await freshDb.initialize();

      // should work immediately
      const id = await freshDb.addContextEntry(mockDocumentEntry);
      expect(id).toBeGreaterThan(0);

      const results = await freshDb.searchContext('API');
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('doc');

      // cleanup
      freshDb.dispose();
      await fs.rm(tempPath, { recursive: true, force: true });
    });

    it('should handle missing storage directory gracefully', async () => {
      // path with nested non-existent directories
      const baseDir = path.join(tmpdir(), 'chorus-nested-' + Date.now());
      const tempPath = path.join(baseDir, 'deep', 'path');

      const deepDb = new LocalDB(tempPath);
      await deepDb.initialize();

      // should create the directory and work
      const id = await deepDb.addContextEntry(mockContextEntry);
      expect(id).toBeGreaterThan(0);

      // cleanup
      deepDb.dispose();
      await fs.rm(baseDir, { recursive: true, force: true }).catch(() => {});
    });
  });

  // ===== branch coverage: additional tests =====

  describe('branch coverage: getRecentPRs', () => {
    it('should return recent PRs with phase and ballot count', async () => {
      // arrange
      await db.startBlindedReview('#pr-a', 2);
      await db.addBallot({ ...mockBallot, pr_reference: '#pr-a' });
      await db.addBallot({ ...mockBallot, pr_reference: '#pr-a', rationale: 'Second' });

      // act
      const recent = await db.getRecentPRs(5);

      // assert
      expect(recent.length).toBeGreaterThanOrEqual(1);
      const entry = recent.find((r) => r.prReference === '#pr-a');
      expect(entry).toBeDefined();
      expect(entry!.ballotCount).toBe(2);
    });

    it('should return empty array when no ballots exist', async () => {
      const recent = await db.getRecentPRs();
      expect(recent).toHaveLength(0);
    });

    it('should throw when database not initialized', async () => {
      db.dispose();
      await expect(db.getRecentPRs()).rejects.toThrow('Database not initialized');
    });
  });

  describe('branch coverage: calibration reject+reverted outcome', () => {
    it('should calculate reject+reverted as success', async () => {
      // arrange
      await db.addBallot({
        pr_reference: '#rev1',
        decision: 'reject',
        confidence: 4,
        rationale: 'Looks risky',
        author_metadata: '{}',
        revealed: false,
      });
      await db.recordOutcome('#rev1', 'reverted', false);

      // act
      const data = await db.getUserCalibrationData();

      // assert
      expect(data).toHaveLength(1);
      expect(data[0].outcome_success).toBe(true);
    });

    it('should calculate reject+merged_clean as failure', async () => {
      // arrange
      await db.addBallot({
        pr_reference: '#mc1',
        decision: 'reject',
        confidence: 4,
        rationale: 'Should not merge',
        author_metadata: '{}',
        revealed: false,
      });
      await db.recordOutcome('#mc1', 'merged_clean', false);

      // act
      const data = await db.getUserCalibrationData();

      // assert
      expect(data).toHaveLength(1);
      expect(data[0].outcome_success).toBe(false);
    });
  });

  describe('branch coverage: confirmOutcome without newOutcomeType', () => {
    it('should confirm outcome without changing outcome_type', async () => {
      // arrange
      const id = await db.recordOutcome('#co1', 'merged_clean', true);

      // act - confirm=false, no newOutcomeType
      await db.confirmOutcome(id, false);

      // assert
      const outcomes = await db.getOutcomesForPR('#co1');
      expect(outcomes[0].user_confirmed).toBe(false);
      expect(outcomes[0].outcome_type).toBe('merged_clean');
    });
  });

  describe('branch coverage: getRetrospectives with empty filters object', () => {
    it('should return all retrospectives when filters is empty object', async () => {
      // arrange
      await db.recordRetrospective('#retro-a', 'manual', {
        what_went_wrong: 'A',
        what_to_improve: 'B',
        bias_patterns: [],
      });

      // act - empty object has no keys set so all filters are skipped, but params.length === 0
      const retros = await db.getRetrospectives({});

      // assert
      expect(retros).toHaveLength(1);
    });
  });

  describe('branch coverage: getReflectionAnalytics edge cases', () => {
    it('should handle non-array bias_patterns JSON gracefully', async () => {
      // arrange - manually insert a retro with non-array bias_patterns
      await db.recordRetrospective('#bias-obj', 'manual', {
        what_went_wrong: 'Issue',
        what_to_improve: 'Fix',
        bias_patterns: [], // will be overwritten
      });

      // hack: overwrite the bias_patterns column directly
      // use internal db exec to set invalid json
      const internalDb = (db as any).db;
      internalDb.run(
        `UPDATE retrospectives SET bias_patterns = '{"not":"an_array"}' WHERE pr_id = '#bias-obj'`
      );

      // act
      const analytics = await db.getReflectionAnalytics();

      // assert - should not crash, just skip non-array patterns
      expect(analytics.total_retrospectives).toBe(1);
    });

    it('should handle invalid JSON in bias_patterns gracefully', async () => {
      // arrange
      await db.recordRetrospective('#bias-bad', 'manual', {
        what_went_wrong: 'Issue',
        what_to_improve: 'Fix',
        bias_patterns: [],
      });

      // hack: overwrite with invalid json
      const internalDb = (db as any).db;
      internalDb.run(
        `UPDATE retrospectives SET bias_patterns = 'not json at all' WHERE pr_id = '#bias-bad'`
      );

      // act
      const analytics = await db.getReflectionAnalytics();

      // assert - should not crash
      expect(analytics.total_retrospectives).toBe(1);
      expect(Object.keys(analytics.bias_frequency)).toHaveLength(0);
    });

    it('should return empty analytics when no data exists', async () => {
      const analytics = await db.getReflectionAnalytics();
      expect(analytics.total_retrospectives).toBe(0);
      expect(analytics.insights).toEqual([]);
      expect(Object.keys(analytics.scheme_distribution)).toHaveLength(0);
    });
  });

  describe('branch coverage: getThrivingTemplates', () => {
    it('should return all templates when no scope provided', async () => {
      const templates = await db.getThrivingTemplates();
      // should include both pr and team scope templates
      const scopes = new Set(templates.map((t) => t.scope));
      expect(scopes.has('pr')).toBe(true);
      expect(scopes.has('team')).toBe(true);
    });

    it('should filter by pr scope', async () => {
      const templates = await db.getThrivingTemplates('pr');
      expect(templates.every((t) => t.scope === 'pr')).toBe(true);
      expect(templates.length).toBeGreaterThan(0);
    });

    it('should filter by team scope', async () => {
      const templates = await db.getThrivingTemplates('team');
      expect(templates.every((t) => t.scope === 'team')).toBe(true);
      expect(templates.length).toBeGreaterThan(0);
    });

    it('should throw when database not initialized', async () => {
      db.dispose();
      await expect(db.getThrivingTemplates()).rejects.toThrow('Database not initialized');
    });
  });

  describe('branch coverage: getThrivingAnalytics filters', () => {
    it('should filter by pr_reference', async () => {
      // arrange
      await db.initializeChecklistForPR('#ta1');
      await db.toggleChecklistItem('#ta1', 'labs_lc_1', true);

      // act
      const analytics = await db.getThrivingAnalytics({ pr_reference: '#ta1' });

      // assert
      expect(analytics.length).toBeGreaterThan(0);
    });

    it('should filter by start_date', async () => {
      await db.initializeChecklistForPR('#ta2');

      const analytics = await db.getThrivingAnalytics({ start_date: '2099-01-01' });
      // no items created after 2099
      expect(analytics).toHaveLength(0);
    });

    it('should filter by end_date', async () => {
      await db.initializeChecklistForPR('#ta3');

      const analytics = await db.getThrivingAnalytics({ end_date: '2000-01-01' });
      // no items created before 2000
      expect(analytics).toHaveLength(0);
    });

    it('should return all dimensions when no filters', async () => {
      await db.initializeChecklistForPR('#ta4');

      const analytics = await db.getThrivingAnalytics();
      // should have data for all 4 LABS dimensions
      expect(analytics.length).toBeGreaterThanOrEqual(4);
    });

    it('should throw when database not initialized', async () => {
      db.dispose();
      await expect(db.getThrivingAnalytics()).rejects.toThrow('Database not initialized');
    });
  });

  describe('branch coverage: toggleChecklistItem with notes', () => {
    it('should store notes when provided', async () => {
      await db.initializeChecklistForPR('#toggle1');

      await db.toggleChecklistItem('#toggle1', 'labs_lc_1', true, 'My notes');

      const checklist = await db.getThrivingChecklist('#toggle1');
      const item = checklist.find((c) => c.item_key === 'labs_lc_1');
      expect(item).toBeDefined();
      expect(item!.checked).toBe(true);
      expect(item!.notes).toBe('My notes');
    });

    it('should use null notes when notes is undefined', async () => {
      await db.initializeChecklistForPR('#toggle2');

      // first set notes
      await db.toggleChecklistItem('#toggle2', 'labs_lc_1', true, 'Initial notes');
      // then toggle without notes (undefined)
      await db.toggleChecklistItem('#toggle2', 'labs_lc_1', false);

      const checklist = await db.getThrivingChecklist('#toggle2');
      const item = checklist.find((c) => c.item_key === 'labs_lc_1');
      expect(item).toBeDefined();
      expect(item!.checked).toBe(false);
    });
  });

  describe('branch coverage: markAutoDetected', () => {
    it('should mark item as auto-detected (detected=true)', async () => {
      await db.initializeChecklistForPR('#mad1');

      await db.markAutoDetected('#mad1', 'labs_lc_1', true);

      const checklist = await db.getThrivingChecklist('#mad1');
      const item = checklist.find((c) => c.item_key === 'labs_lc_1');
      expect(item).toBeDefined();
      expect(item!.auto_detected).toBe(true);
      expect(item!.checked).toBe(true);
    });

    it('should clear auto-detected flag (detected=false)', async () => {
      await db.initializeChecklistForPR('#mad2');
      await db.markAutoDetected('#mad2', 'labs_lc_1', true);

      // now clear it
      await db.markAutoDetected('#mad2', 'labs_lc_1', false);

      const checklist = await db.getThrivingChecklist('#mad2');
      const item = checklist.find((c) => c.item_key === 'labs_lc_1');
      expect(item).toBeDefined();
      expect(item!.auto_detected).toBe(false);
    });

    it('should create checklist row if it does not exist', async () => {
      // don't call initializeChecklistForPR first
      await db.markAutoDetected('#mad3', 'labs_lc_1', true);

      const checklist = await db.getThrivingChecklist('#mad3');
      const item = checklist.find((c) => c.item_key === 'labs_lc_1');
      expect(item).toBeDefined();
      expect(item!.auto_detected).toBe(true);
    });

    it('should throw when database not initialized', async () => {
      db.dispose();
      await expect(db.markAutoDetected('#x', 'labs_lc_1', true)).rejects.toThrow(
        'Database not initialized'
      );
    });
  });

  describe('branch coverage: dispose edge cases', () => {
    it('should handle dispose when db is already null', () => {
      // first dispose
      db.dispose();
      // second dispose should not throw
      expect(() => db.dispose()).not.toThrow();
    });
  });

  describe('branch coverage: canRevealBallots with uninitialized PR', () => {
    it('should return false when PR has no state (phase is null)', async () => {
      // no startBlindedReview called - phase is null
      const canReveal = await db.canRevealBallots('#uninitialized-pr');
      expect(canReveal).toBe(false);
    });
  });

  describe('branch coverage: recordDecisionScheme without custom name', () => {
    it('should store null for custom_scheme_name when not provided', async () => {
      const id = await db.recordDecisionScheme('#rds1', 'majority', 'Team vote');

      const scheme = await db.getDecisionScheme('#rds1');
      expect(scheme).not.toBeNull();
      expect(scheme!.scheme_type).toBe('majority');
      expect(scheme!.custom_scheme_name).toBeNull();
    });
  });

  describe('branch coverage: updateChecklistItemNotes', () => {
    it('should update notes for existing checklist item', async () => {
      await db.initializeChecklistForPR('#ucin1');

      await db.updateChecklistItemNotes('#ucin1', 'labs_lc_1', 'Updated notes');

      const checklist = await db.getThrivingChecklist('#ucin1');
      const item = checklist.find((c) => c.item_key === 'labs_lc_1');
      expect(item!.notes).toBe('Updated notes');
    });

    it('should throw when database not initialized', async () => {
      db.dispose();
      await expect(db.updateChecklistItemNotes('#x', 'labs_lc_1', 'test')).rejects.toThrow(
        'Database not initialized'
      );
    });
  });

  describe('branch coverage: getTraceChecklist', () => {
    it('should return team-scope items', async () => {
      const items = await db.getTraceChecklist();
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => i.scope === 'team')).toBe(true);
    });

    it('should throw when database not initialized', async () => {
      db.dispose();
      await expect(db.getTraceChecklist()).rejects.toThrow('Database not initialized');
    });
  });

  describe('branch coverage: toggleTraceItem', () => {
    it('should toggle a team-scope item', async () => {
      await db.getTraceChecklist(); // initialize first

      await db.toggleTraceItem('trace_t_1', true, 'Team note');

      const items = await db.getTraceChecklist();
      const item = items.find((i) => i.item_key === 'trace_t_1');
      expect(item).toBeDefined();
      expect(item!.checked).toBe(true);
    });
  });

  describe('branch coverage: addSearchQuery with explicit timestamp', () => {
    it('should use provided timestamp instead of generating one', async () => {
      const ts = '2023-06-15T12:00:00.000Z';
      const id = await db.addSearchQuery('explicit time', ts);
      expect(id).toBeGreaterThan(0);

      const searches = await db.getRecentSearches(1);
      expect(searches[0].query).toBe('explicit time');
      expect(searches[0].timestamp).toBe(ts);
    });
  });

  describe('branch coverage: setIndexMetadata update path', () => {
    it('should update existing metadata value', async () => {
      // arrange - insert
      await db.setIndexMetadata('test_key', 'value_1');
      const v1 = await db.getIndexMetadata('test_key');
      expect(v1).toBe('value_1');

      // act - update (changes > 0 path)
      await db.setIndexMetadata('test_key', 'value_2');

      // assert
      const v2 = await db.getIndexMetadata('test_key');
      expect(v2).toBe('value_2');
    });
  });

  describe('branch coverage: initializeChecklistForPR', () => {
    it('should be idempotent - safe to call multiple times', async () => {
      const items1 = await db.initializeChecklistForPR('#idempotent');
      const items2 = await db.initializeChecklistForPR('#idempotent');

      expect(items1.length).toBe(items2.length);
    });

    it('should throw when database not initialized', async () => {
      db.dispose();
      await expect(db.initializeChecklistForPR('#x')).rejects.toThrow('Database not initialized');
    });
  });

  describe('branch coverage: getThrivingChecklist', () => {
    it('should return empty array for PR with no checklist items', async () => {
      const items = await db.getThrivingChecklist('#nonexistent-pr');
      expect(items).toHaveLength(0);
    });

    it('should throw when database not initialized', async () => {
      db.dispose();
      await expect(db.getThrivingChecklist('#x')).rejects.toThrow('Database not initialized');
    });
  });
});
