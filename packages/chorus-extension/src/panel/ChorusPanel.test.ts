import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestDatabase, mockBallot } from '../test/testUtils';
import { LocalDB, BallotEntry } from '../storage/LocalDB';

// mock vscode module
vi.mock('vscode', () => ({
  window: {
    activeTextEditor: undefined,
    createWebviewPanel: vi.fn(),
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    showErrorMessage: vi.fn().mockResolvedValue(undefined),
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
    showQuickPick: vi.fn(),
  },
  Uri: {
    file: vi.fn((p: string) => ({ fsPath: p, with: vi.fn() })),
    joinPath: vi.fn((...args: any[]) => ({ fsPath: args.map(String).join('/') })),
    parse: vi.fn((url: string) => ({ toString: () => url })),
  },
  ViewColumn: { One: 1, Two: 2 },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn().mockReturnValue(false) })),
  },
  env: {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    openExternal: vi.fn(),
  },
}));

// mock GitConfigService
vi.mock('../services/GitConfigService', () => ({
  getGitUserInfo: vi.fn().mockResolvedValue({ name: 'Test User', email: 'test@example.com' }),
}));

// mock GitService (dynamic import in handleAutoDetectPR)
vi.mock('../services/GitService', () => ({
  getCurrentBranch: vi.fn().mockResolvedValue('feat/pr-42-add-feature'),
  extractPRNumberFromBranch: vi.fn().mockReturnValue('42'),
}));

// mock ReflectionService (dynamic import in handleAnalyzePatterns/handleExportReport)
vi.mock('../services/ReflectionService', () => ({
  ReflectionService: vi.fn().mockImplementation(() => ({
    detectPatterns: vi.fn().mockResolvedValue([]),
    exportRetrospectiveReport: vi.fn().mockResolvedValue('# Report'),
  })),
}));

// mock calibration (dynamic import in handleGetCalibrationData)
vi.mock('../utils/calibration', () => ({
  calculateCalibrationMetrics: vi.fn().mockReturnValue({
    brierScore: 0.2,
    totalPredictions: 5,
    overallAccuracy: 0.8,
    calibrationCurve: [],
    insights: ['Good calibration'],
  }),
}));

import * as vscode from 'vscode';
import { ChorusPanel } from './ChorusPanel';

// small delay to let fire-and-forget promises settle
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

// helper: create a mock webview panel and capture the message handler
function createMockWebviewPanel(): {
  mockPanel: any;
  getMessageHandler: () => (msg: any) => Promise<void>;
} {
  let messageHandler: ((msg: any) => Promise<void>) | undefined;

  const mockPanel = {
    webview: {
      html: '',
      postMessage: vi.fn().mockResolvedValue(true),
      onDidReceiveMessage: vi.fn((handler: any, _thisArg: any, disposables: any[]) => {
        messageHandler = handler;
        const disposable = { dispose: vi.fn() };
        if (disposables) {
          disposables.push(disposable);
        }
        return disposable;
      }),
      asWebviewUri: vi.fn((uri: any) => uri),
      cspSource: 'test-csp',
    },
    onDidDispose: vi.fn((handler: any, _thisArg: any, disposables: any[]) => {
      const disposable = { dispose: vi.fn() };
      if (disposables) {
        disposables.push(disposable);
      }
      return disposable;
    }),
    dispose: vi.fn(),
    reveal: vi.fn(),
    visible: true,
    title: '',
  };

  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(mockPanel as any);

  return {
    mockPanel,
    getMessageHandler: () => {
      if (!messageHandler) {
        throw new Error('Message handler not registered. Call createOrShow first.');
      }
      return messageHandler;
    },
  };
}

describe('ChorusPanel', () => {
  let testDb: TestDatabase;
  let db: LocalDB;

  beforeEach(async () => {
    testDb = new TestDatabase();
    db = testDb.db;
    await testDb.setup();

    // reset singleton
    ChorusPanel.currentPanel = undefined;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    ChorusPanel.currentPanel = undefined;
    await testDb.cleanup();
  });

  // helper to set up the panel and get the message handler.
  // waits for the constructor's fire-and-forget auto-detect to settle,
  // then clears mocks so tests start clean.
  async function setupPanel(githubService?: any): Promise<{
    mockPanel: any;
    send: (msg: any) => Promise<void>;
  }> {
    const { mockPanel, getMessageHandler } = createMockWebviewPanel();
    const extensionUri = { fsPath: '/test/extension' } as any;
    ChorusPanel.createOrShow(extensionUri, db, githubService);

    // let the constructor's background handleAutoDetectPR() settle
    await tick();
    vi.clearAllMocks();

    return { mockPanel, send: getMessageHandler() };
  }

  // ----- createOrShow -----
  describe('createOrShow', () => {
    it('should create a new panel when none exists', () => {
      createMockWebviewPanel();
      const extensionUri = { fsPath: '/test/extension' } as any;

      ChorusPanel.createOrShow(extensionUri, db);

      expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
        'chorus.panel',
        'Chorus',
        1,
        expect.objectContaining({ enableScripts: true })
      );
      expect(ChorusPanel.currentPanel).toBeDefined();
    });

    it('should reveal existing panel instead of creating new one', async () => {
      const { mockPanel } = createMockWebviewPanel();
      const extensionUri = { fsPath: '/test/extension' } as any;

      ChorusPanel.createOrShow(extensionUri, db);
      await tick();
      vi.clearAllMocks();

      ChorusPanel.createOrShow(extensionUri, db);

      expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
      expect(mockPanel.reveal).toHaveBeenCalled();
    });
  });

  // ----- handleSubmitBallot -----
  describe('handleSubmitBallot', () => {
    it('should submit a valid ballot and confirm success', async () => {
      const { mockPanel, send } = await setupPanel();
      const prRef = '#200';
      await db.startBlindedReview(prRef, 3);

      await send({
        command: 'submitBallot',
        ballot: {
          prReference: prRef,
          decision: 'approve',
          confidence: 4,
          rationale: 'Solid implementation',
        },
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'ballotSubmitted', success: true })
      );

      // verify ballot actually stored
      const ballots = await db.getBallotsByPR(prRef);
      expect(ballots).toHaveLength(1);
      expect(ballots[0].decision).toBe('approve');
    });

    it('should reject ballot when PR is not in blinded phase', async () => {
      const { mockPanel, send } = await setupPanel();

      // put PR into revealed phase so canSubmitBallot returns false
      const prRef = '#999';
      await db.startBlindedReview(prRef, 1);
      await db.addBallot({ ...mockBallot, pr_reference: prRef });
      await db.revealBallots(prRef);

      await send({
        command: 'submitBallot',
        ballot: {
          prReference: prRef,
          decision: 'approve',
          confidence: 4,
          rationale: 'Whatever',
        },
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: 'Ballots cannot be submitted after the reveal phase has begun',
        })
      );
    });

    it('should require mainRisk nudge when confidence < 3', async () => {
      const { mockPanel, send } = await setupPanel();
      const prRef = '#201';
      await db.startBlindedReview(prRef, 3);

      await send({
        command: 'submitBallot',
        ballot: {
          prReference: prRef,
          decision: 'reject',
          confidence: 2,
          rationale: 'Not sure about this',
          nudge_responses: { mainRisk: '', consideredAlternatives: false },
        },
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: 'Main Risk is Required When Confidence is Below 3',
        })
      );
    });

    it('should accept ballot with confidence < 3 when mainRisk is provided', async () => {
      const { mockPanel, send } = await setupPanel();
      const prRef = '#202';
      await db.startBlindedReview(prRef, 3);

      await send({
        command: 'submitBallot',
        ballot: {
          prReference: prRef,
          decision: 'reject',
          confidence: 1,
          rationale: 'Concerned about security',
          nudge_responses: {
            mainRisk: 'SQL injection risk',
            consideredAlternatives: true,
          },
        },
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'ballotSubmitted', success: true })
      );

      // verify nudge_responses stored
      const ballots = await db.getBallotsByPR(prRef);
      expect(ballots).toHaveLength(1);
      expect(ballots[0].nudge_responses).toBeDefined();
      const nudges = JSON.parse(ballots[0].nudge_responses!);
      expect(nudges.mainRisk).toBe('SQL injection risk');
    });

    it('should submit ballot without nudge_responses when confidence >= 3', async () => {
      const { mockPanel, send } = await setupPanel();
      const prRef = '#203';
      await db.startBlindedReview(prRef, 3);

      await send({
        command: 'submitBallot',
        ballot: {
          prReference: prRef,
          decision: 'neutral',
          confidence: 3,
          rationale: 'Looks okay',
        },
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'ballotSubmitted', success: true })
      );
    });
  });

  // ----- handleRevealBallots -----
  describe('handleRevealBallots', () => {
    it('should reveal ballots when threshold is met', async () => {
      const { mockPanel, send } = await setupPanel();
      const prRef = '#300';
      await db.startBlindedReview(prRef, 2);
      await db.addBallot({ ...mockBallot, pr_reference: prRef });
      await db.addBallot({ ...mockBallot, pr_reference: prRef, decision: 'neutral' });

      await send({ command: 'revealBallots', prReference: prRef });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'ballotsRevealed',
          ballots: expect.any(Array),
        })
      );
    });

    it('should error when ballots have already been revealed', async () => {
      const { mockPanel, send } = await setupPanel();
      const prRef = '#301';
      await db.startBlindedReview(prRef, 1);
      await db.addBallot({ ...mockBallot, pr_reference: prRef });
      await db.revealBallots(prRef);

      await send({ command: 'revealBallots', prReference: prRef });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: 'Ballots Have Already Been Revealed',
        })
      );
    });

    it('should error when PR review not started', async () => {
      const { mockPanel, send } = await setupPanel();

      await send({ command: 'revealBallots', prReference: '#302' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: 'PR Review Not Started - Use "Start Blinded Review" First',
        })
      );
    });

    it('should error when threshold not met', async () => {
      const { mockPanel, send } = await setupPanel();
      const prRef = '#303';
      await db.startBlindedReview(prRef, 3);
      await db.addBallot({ ...mockBallot, pr_reference: prRef });

      await send({ command: 'revealBallots', prReference: prRef });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: expect.stringContaining('Minimum Threshold Not Met'),
        })
      );
    });
  });

  // ----- handleAutoDetectPR -----
  describe('handleAutoDetectPR', () => {
    it('should detect PR from branch name and send to webview', async () => {
      const { mockPanel, send } = await setupPanel();

      await send({ command: 'autoDetectPR' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'prAutoDetected',
          data: expect.objectContaining({
            branch: 'feat/pr-42-add-feature',
            prReference: '#42',
          }),
        })
      );
    });

    it('should send null prReference when branch has no PR number', async () => {
      // set up mock before creating the panel
      const { extractPRNumberFromBranch } = await import('../services/GitService');
      vi.mocked(extractPRNumberFromBranch).mockReturnValue(null);

      const { mockPanel, send } = await setupPanel();

      await send({ command: 'autoDetectPR' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'prAutoDetected',
          data: expect.objectContaining({
            prReference: null,
          }),
        })
      );

      // restore default
      vi.mocked(extractPRNumberFromBranch).mockReturnValue('42');
    });

    it('should silently return when no workspace folders', async () => {
      const origFolders = (vscode.workspace as any).workspaceFolders;
      (vscode.workspace as any).workspaceFolders = undefined;

      const { mockPanel, send } = await setupPanel();

      await send({ command: 'autoDetectPR' });

      // should not post prAutoDetected (it returns early)
      const prAutoDetectedCalls = vi
        .mocked(mockPanel.webview.postMessage)
        .mock.calls.filter((call: any[]) => call[0]?.command === 'prAutoDetected');
      expect(prAutoDetectedCalls).toHaveLength(0);

      // restore
      (vscode.workspace as any).workspaceFolders = origFolders;
    });

    it('should include existsInDB info when PR has been reviewed', async () => {
      const prRef = '#42';
      await db.startBlindedReview(prRef, 3);
      await db.addBallot({ ...mockBallot, pr_reference: prRef });

      const { mockPanel, send } = await setupPanel();

      await send({ command: 'autoDetectPR' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'prAutoDetected',
          data: expect.objectContaining({
            existsInDB: true,
            ballotCount: 1,
          }),
        })
      );
    });

    it('should fetch PR title from GitHub when service available', async () => {
      const mockGitHubService = {
        detectGitHubRepo: vi.fn().mockResolvedValue({ owner: 'test', repo: 'repo' }),
        getPullRequest: vi.fn().mockResolvedValue({ title: 'Add feature X' }),
        parsePRReference: vi.fn(),
        createPRComment: vi.fn(),
      };

      const { mockPanel, send } = await setupPanel(mockGitHubService);

      await send({ command: 'autoDetectPR' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'prAutoDetected',
          data: expect.objectContaining({
            prTitle: 'Add feature X',
          }),
        })
      );
    });
  });

  // ----- formatBallotSummary (tested via postBallotsToGitHub reveal flow) -----
  describe('formatBallotSummary', () => {
    // formatBallotSummary is private, so we test it indirectly through postBallotsToGitHub
    // by intercepting the comment body passed to createPRComment

    it('should format decision distribution correctly', async () => {
      const mockGitHubService = {
        detectGitHubRepo: vi.fn().mockResolvedValue({ owner: 'test', repo: 'repo' }),
        getPullRequest: vi.fn().mockResolvedValue(null),
        parsePRReference: vi.fn().mockReturnValue({ owner: 'test', repo: 'repo', number: 400 }),
        createPRComment: vi.fn().mockResolvedValue(undefined),
      };

      const { mockPanel, send } = await setupPanel(mockGitHubService);

      const prRef = 'test/repo#400';
      await db.startBlindedReview(prRef, 2);
      await db.addBallot({
        ...mockBallot,
        pr_reference: prRef,
        decision: 'approve',
        confidence: 5,
      });
      await db.addBallot({
        ...mockBallot,
        pr_reference: prRef,
        decision: 'approve',
        confidence: 4,
      });
      await db.addBallot({
        ...mockBallot,
        pr_reference: prRef,
        decision: 'reject',
        confidence: 2,
      });

      // enable auto-post so we don't need user prompt
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn().mockReturnValue(true),
      } as any);

      await send({ command: 'revealBallots', prReference: prRef });

      // wait for background github posting to settle
      await tick();

      expect(mockGitHubService.createPRComment).toHaveBeenCalled();
      const commentBody = mockGitHubService.createPRComment.mock.calls[0][3];
      expect(commentBody).toContain('Ballots Submitted**: 3');
      expect(commentBody).toContain('Approve: 2 (67%)');
      expect(commentBody).toContain('Reject: 1 (33%)');
      expect(commentBody).toContain('Neutral: 0 (0%)');
      expect(commentBody).toContain('High (4-5): 2');
      expect(commentBody).toContain('Low (1-2): 1');
    });

    it('should include nudge summary when nudge responses exist', async () => {
      const mockGitHubService = {
        detectGitHubRepo: vi.fn().mockResolvedValue({ owner: 'test', repo: 'repo' }),
        getPullRequest: vi.fn().mockResolvedValue(null),
        parsePRReference: vi.fn().mockReturnValue({ owner: 'test', repo: 'repo', number: 401 }),
        createPRComment: vi.fn().mockResolvedValue(undefined),
      };

      const { send } = await setupPanel(mockGitHubService);

      const prRef = 'test/repo#401';
      await db.startBlindedReview(prRef, 1);

      const nudgeJson = JSON.stringify({
        consideredAlternatives: true,
        mainRisk: 'Performance regression',
        dissentingViews: 'Could use simpler approach',
      });
      await db.addBallot({
        ...mockBallot,
        pr_reference: prRef,
        nudge_responses: nudgeJson,
      });

      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn().mockReturnValue(true),
      } as any);

      await send({ command: 'revealBallots', prReference: prRef });
      await tick();

      expect(mockGitHubService.createPRComment).toHaveBeenCalled();
      const commentBody = mockGitHubService.createPRComment.mock.calls[0][3];
      expect(commentBody).toContain('Key Concerns Raised');
      expect(commentBody).toContain('Performance regression');
      expect(commentBody).toContain('Dissenting Views');
      expect(commentBody).toContain('Could use simpler approach');
      expect(commentBody).toContain('1 out of 1 reviewers considered alternative approaches');
    });
  });

  // ----- postBallotsToGitHub -----
  describe('postBallotsToGitHub', () => {
    it('should skip posting when no github service', async () => {
      const { mockPanel, send } = await setupPanel(undefined);

      const prRef = '#500';
      await db.startBlindedReview(prRef, 1);
      await db.addBallot({ ...mockBallot, pr_reference: prRef });

      await send({ command: 'revealBallots', prReference: prRef });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'ballotsRevealed' })
      );
    });

    it('should prevent duplicate posts', async () => {
      const mockGitHubService = {
        detectGitHubRepo: vi.fn().mockResolvedValue({ owner: 'test', repo: 'repo' }),
        getPullRequest: vi.fn().mockResolvedValue(null),
        parsePRReference: vi.fn().mockReturnValue({ owner: 'test', repo: 'repo', number: 502 }),
        createPRComment: vi.fn().mockResolvedValue(undefined),
      };

      const prRef = 'test/repo#502';
      await db.startBlindedReview(prRef, 1);
      await db.addBallot({ ...mockBallot, pr_reference: prRef });
      await db.markBallotsPostedToGitHub(prRef, 'https://github.com/test/repo/pull/502');

      const { send } = await setupPanel(mockGitHubService);

      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn().mockReturnValue(true),
      } as any);

      await send({ command: 'revealBallots', prReference: prRef });
      await tick();

      // should NOT call createPRComment since already posted
      expect(mockGitHubService.createPRComment).not.toHaveBeenCalled();
    });

    it('should ask user permission when auto-post is disabled', async () => {
      const mockGitHubService = {
        detectGitHubRepo: vi.fn().mockResolvedValue({ owner: 'test', repo: 'repo' }),
        getPullRequest: vi.fn().mockResolvedValue(null),
        parsePRReference: vi.fn().mockReturnValue({ owner: 'test', repo: 'repo', number: 503 }),
        createPRComment: vi.fn().mockResolvedValue(undefined),
      };

      const { send } = await setupPanel(mockGitHubService);

      const prRef = 'test/repo#503';
      await db.startBlindedReview(prRef, 1);
      await db.addBallot({ ...mockBallot, pr_reference: prRef });

      // auto-post disabled
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn().mockReturnValue(false),
      } as any);

      // user clicks "Post"
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Post' as any);

      await send({ command: 'revealBallots', prReference: prRef });
      await tick();

      expect(mockGitHubService.createPRComment).toHaveBeenCalled();
    });

    it('should cancel posting when user declines', async () => {
      const mockGitHubService = {
        detectGitHubRepo: vi.fn().mockResolvedValue({ owner: 'test', repo: 'repo' }),
        getPullRequest: vi.fn().mockResolvedValue(null),
        parsePRReference: vi.fn().mockReturnValue({ owner: 'test', repo: 'repo', number: 504 }),
        createPRComment: vi.fn().mockResolvedValue(undefined),
      };

      const { send } = await setupPanel(mockGitHubService);

      const prRef = 'test/repo#504';
      await db.startBlindedReview(prRef, 1);
      await db.addBallot({ ...mockBallot, pr_reference: prRef });

      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn().mockReturnValue(false),
      } as any);

      // user clicks "Cancel"
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Cancel' as any);

      await send({ command: 'revealBallots', prReference: prRef });
      await tick();

      expect(mockGitHubService.createPRComment).not.toHaveBeenCalled();
    });

    it('should detect repo for short PR references like #123', async () => {
      const mockGitHubService = {
        detectGitHubRepo: vi.fn().mockResolvedValue({ owner: 'org', repo: 'project' }),
        getPullRequest: vi.fn().mockResolvedValue(null),
        parsePRReference: vi.fn().mockReturnValue(null),
        createPRComment: vi.fn().mockResolvedValue(undefined),
      };

      const { send } = await setupPanel(mockGitHubService);

      const prRef = '#505';
      await db.startBlindedReview(prRef, 1);
      await db.addBallot({ ...mockBallot, pr_reference: prRef });

      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn().mockReturnValue(true),
      } as any);

      await send({ command: 'revealBallots', prReference: prRef });
      await tick();

      expect(mockGitHubService.createPRComment).toHaveBeenCalledWith(
        'org',
        'project',
        505,
        expect.any(String)
      );
    });

    it('should show warning when GitHub repo cannot be detected for short ref', async () => {
      const mockGitHubService = {
        detectGitHubRepo: vi.fn().mockResolvedValue(null),
        getPullRequest: vi.fn().mockResolvedValue(null),
        parsePRReference: vi.fn().mockReturnValue(null),
        createPRComment: vi.fn().mockResolvedValue(undefined),
      };

      const { send } = await setupPanel(mockGitHubService);

      const prRef = '#506';
      await db.startBlindedReview(prRef, 1);
      await db.addBallot({ ...mockBallot, pr_reference: prRef });

      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn().mockReturnValue(true),
      } as any);

      await send({ command: 'revealBallots', prReference: prRef });
      await tick();

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Could Not Detect GitHub Repository - Ballots Not Posted'
      );
      expect(mockGitHubService.createPRComment).not.toHaveBeenCalled();
    });

    it('should show error message when createPRComment fails', async () => {
      const mockGitHubService = {
        detectGitHubRepo: vi.fn().mockResolvedValue({ owner: 'test', repo: 'repo' }),
        getPullRequest: vi.fn().mockResolvedValue(null),
        parsePRReference: vi.fn().mockReturnValue({ owner: 'test', repo: 'repo', number: 507 }),
        createPRComment: vi.fn().mockRejectedValue(new Error('API rate limited')),
      };

      const { send } = await setupPanel(mockGitHubService);

      const prRef = 'test/repo#507';
      await db.startBlindedReview(prRef, 1);
      await db.addBallot({ ...mockBallot, pr_reference: prRef });

      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn().mockReturnValue(true),
      } as any);

      await send({ command: 'revealBallots', prReference: prRef });
      await tick();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('API rate limited')
      );
    });
  });

  // ----- handleSearchContext -----
  describe('handleSearchContext', () => {
    it('should search and return results', async () => {
      const { mockPanel, send } = await setupPanel();

      await db.addContextEntry({
        type: 'commit',
        title: 'feat: add auth module',
        path: 'abc123',
        content: 'feat: add auth module\n\nImplemented OAuth2',
        metadata: { hash: 'abc123', author: 'Dev', date: '2023-01-01', files: [] },
      });

      await send({ command: 'searchContext', query: 'auth' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'searchResults',
          results: expect.any(Array),
        })
      );
    });

    it('should send error when search fails', async () => {
      const { mockPanel, send } = await setupPanel();

      vi.spyOn(db, 'searchContext').mockRejectedValueOnce(new Error('DB error'));

      await send({ command: 'searchContext', query: 'test' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: expect.stringContaining('Search failed'),
        })
      );
    });
  });

  // ----- handleGetPRPhase -----
  describe('handleGetPRPhase', () => {
    it('should return phase data for a PR', async () => {
      const { mockPanel, send } = await setupPanel();
      const prRef = '#600';
      await db.startBlindedReview(prRef, 3);
      await db.addBallot({ ...mockBallot, pr_reference: prRef });

      await send({ command: 'getPRPhase', prReference: prRef });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'prPhaseUpdate',
          phaseData: expect.objectContaining({
            phase: 'blinded',
            ballotCount: 1,
            canReveal: false,
            canSubmit: true,
          }),
        })
      );
    });

    it('should handle PR that does not exist', async () => {
      const { mockPanel, send } = await setupPanel();

      await send({ command: 'getPRPhase', prReference: '#nonexistent' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'prPhaseUpdate',
          phaseData: expect.objectContaining({
            phase: null,
            ballotCount: 0,
          }),
        })
      );
    });
  });

  // ----- handleStartBlindedReview -----
  describe('handleStartBlindedReview', () => {
    it('should start blinded review for a new PR', async () => {
      const { mockPanel, send } = await setupPanel();

      await send({
        command: 'startBlindedReview',
        prReference: '#700',
        threshold: 3,
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'blindedReviewStarted',
          success: true,
          prReference: '#700',
          threshold: 3,
        })
      );

      // verify phase is set
      const phase = await db.getPRPhase('#700');
      expect(phase).toBe('blinded');
    });

    it('should error on empty PR reference', async () => {
      const { mockPanel, send } = await setupPanel();

      await send({
        command: 'startBlindedReview',
        prReference: '  ',
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: 'Invalid PR Reference',
        })
      );
    });

    it('should error when PR already has ballots', async () => {
      const { mockPanel, send } = await setupPanel();
      const prRef = '#701';
      await db.startBlindedReview(prRef, 3);
      await db.addBallot({ ...mockBallot, pr_reference: prRef });

      await send({
        command: 'startBlindedReview',
        prReference: prRef,
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: 'PR Already Exists - Ballots Have Been Submitted',
        })
      );
    });

    it('should default threshold to 3', async () => {
      const { mockPanel, send } = await setupPanel();

      await send({
        command: 'startBlindedReview',
        prReference: '#702',
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'blindedReviewStarted',
          threshold: 3,
        })
      );
    });
  });

  // ----- handleGetCalibrationData -----
  describe('handleGetCalibrationData', () => {
    it('should return calibration metrics and history', async () => {
      const { mockPanel, send } = await setupPanel();

      await send({ command: 'getCalibrationData' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'calibrationData',
          data: expect.objectContaining({
            brierScore: 0.2,
            totalPredictions: 5,
            overallAccuracy: 0.8,
          }),
        })
      );
    });
  });

  // ----- handleGetThrivingChecklist -----
  describe('handleGetThrivingChecklist', () => {
    it('should return empty state when no PR reference', async () => {
      const { mockPanel, send } = await setupPanel();

      await send({ command: 'getThrivingChecklist', prReference: '' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'thrivingChecklistLoaded',
          data: { labsItems: [], traceItems: [], autoDetectedKeys: [] },
        })
      );
    });

    it('should return checklist items when PR is provided', async () => {
      const { mockPanel, send } = await setupPanel();

      await send({ command: 'getThrivingChecklist', prReference: '#800' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'thrivingChecklistLoaded',
          data: expect.objectContaining({
            labsItems: expect.any(Array),
            traceItems: expect.any(Array),
            autoDetectedKeys: expect.any(Array),
          }),
        })
      );
    });

    it('should use currentPRReference as fallback', async () => {
      const { mockPanel, send } = await setupPanel();

      // set currentPRReference by calling getPRPhase first
      await send({ command: 'getPRPhase', prReference: '#801' });
      vi.mocked(mockPanel.webview.postMessage).mockClear();

      // now call without prReference - should fall back to currentPRReference
      await send({ command: 'getThrivingChecklist', prReference: '' });

      const calls = vi.mocked(mockPanel.webview.postMessage).mock.calls;
      const thrivingCall = calls.find((c: any[]) => c[0]?.command === 'thrivingChecklistLoaded');
      expect(thrivingCall).toBeDefined();
      expect(thrivingCall![0].data.labsItems.length).toBeGreaterThan(0);
    });
  });

  // ----- handleToggleThrivingItem -----
  describe('handleToggleThrivingItem', () => {
    it('should toggle item and confirm', async () => {
      const { mockPanel, send } = await setupPanel();
      await db.initializeChecklistForPR('#900');

      await send({
        command: 'toggleThrivingItem',
        prReference: '#900',
        itemKey: 'labs_lc_1',
        checked: true,
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'thrivingItemToggled',
          itemKey: 'labs_lc_1',
          checked: true,
        })
      );
    });
  });

  // ----- handleToggleTraceItem -----
  describe('handleToggleTraceItem', () => {
    it('should toggle trace item and confirm', async () => {
      const { mockPanel, send } = await setupPanel();
      await db.getTraceChecklist();

      await send({
        command: 'toggleTraceItem',
        itemKey: 'trace_t_1',
        checked: true,
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'thrivingItemToggled',
          itemKey: 'trace_t_1',
          checked: true,
        })
      );
    });
  });

  // ----- handleGetThrivingAnalytics -----
  describe('handleGetThrivingAnalytics', () => {
    it('should compute and send analytics', async () => {
      const { mockPanel, send } = await setupPanel();
      await db.initializeChecklistForPR('#1000');

      await send({ command: 'getThrivingAnalytics' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'thrivingAnalyticsLoaded',
          data: expect.objectContaining({
            dimensions: expect.any(Array),
            trace_completion: expect.any(Number),
            overall_thriving_score: expect.any(Number),
          }),
        })
      );
    });
  });

  // ----- handleSaveDecisionScheme -----
  describe('handleSaveDecisionScheme', () => {
    it('should save decision scheme and confirm', async () => {
      const { mockPanel, send } = await setupPanel();

      // set currentPRReference
      await send({ command: 'getPRPhase', prReference: '#1100' });
      vi.mocked(mockPanel.webview.postMessage).mockClear();

      await send({
        command: 'saveDecisionScheme',
        data: {
          scheme_type: 'consensus',
          rationale: 'Team agreed unanimously',
        },
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'decisionSchemeSaved' })
      );

      const scheme = await db.getDecisionScheme('#1100');
      expect(scheme).toBeDefined();
      expect(scheme!.scheme_type).toBe('consensus');
    });
  });

  // ----- handleSaveRetrospective -----
  describe('handleSaveRetrospective', () => {
    it('should save retrospective and confirm', async () => {
      const { mockPanel, send } = await setupPanel();

      // set currentPRReference
      await send({ command: 'getPRPhase', prReference: '#1200' });
      vi.mocked(mockPanel.webview.postMessage).mockClear();

      await send({
        command: 'saveRetrospective',
        data: {
          what_went_wrong: 'Missed edge case in validation',
          what_to_improve: 'Add fuzz testing',
          bias_patterns: ['groupthink'],
        },
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'retrospectiveSaved' })
      );

      const retros = await db.getRetrospectives({ pr_id: '#1200' });
      expect(retros).toHaveLength(1);
      expect(retros[0].what_went_wrong).toContain('Missed edge case');
    });
  });

  // ----- dispose -----
  describe('dispose', () => {
    it('should clear currentPanel and dispose resources', async () => {
      const { mockPanel } = await setupPanel();

      expect(ChorusPanel.currentPanel).toBeDefined();

      ChorusPanel.currentPanel!.dispose();

      expect(ChorusPanel.currentPanel).toBeUndefined();
      expect(mockPanel.dispose).toHaveBeenCalled();
    });
  });

  // ----- handleGetRecentPRs -----
  describe('handleGetRecentPRs', () => {
    it('should return recent PRs', async () => {
      const { mockPanel, send } = await setupPanel();

      await db.startBlindedReview('#rec1', 3);
      await db.addBallot({ ...mockBallot, pr_reference: '#rec1' });

      await send({ command: 'getRecentPRs' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'recentPRs',
          data: expect.any(Array),
        })
      );
    });
  });

  // ----- handleGetReflectionTimeline -----
  describe('handleGetReflectionTimeline', () => {
    it('should return timeline data', async () => {
      const { mockPanel, send } = await setupPanel();

      await send({ command: 'getReflectionTimeline', filters: {} });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'reflectionTimeline',
          timeline: expect.any(Array),
        })
      );
    });
  });

  // ----- handleRefreshThrivingAutoDetect -----
  describe('handleRefreshThrivingAutoDetect', () => {
    it('should run auto-detection and send detected keys', async () => {
      const { mockPanel, send } = await setupPanel();

      const prRef = '#1300';
      await db.initializeChecklistForPR(prRef);
      await db.addBallot({ ...mockBallot, pr_reference: prRef });

      await send({ command: 'refreshThrivingAutoDetect', prReference: prRef });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'thrivingAutoDetectComplete',
          detectedKeys: expect.arrayContaining(['labs_se_1']),
        })
      );
    });

    it('should silently return when no PR reference', async () => {
      const { mockPanel, send } = await setupPanel();

      await send({ command: 'refreshThrivingAutoDetect', prReference: '' });

      const autoDetectCalls = vi
        .mocked(mockPanel.webview.postMessage)
        .mock.calls.filter((call: any[]) => call[0]?.command === 'thrivingAutoDetectComplete');
      expect(autoDetectCalls).toHaveLength(0);
    });
  });

  // ----- handleUpdateThrivingNotes -----
  describe('handleUpdateThrivingNotes', () => {
    it('should update notes without error', async () => {
      const { send } = await setupPanel();
      await db.initializeChecklistForPR('#1400');

      // should not throw
      await send({
        command: 'updateThrivingNotes',
        prReference: '#1400',
        itemKey: 'labs_lc_1',
        notes: 'Great learning opportunity',
      });
    });
  });

  // ----- handleAnalyzePatterns -----
  describe('handleAnalyzePatterns', () => {
    it('should return pattern insights', async () => {
      const { mockPanel, send } = await setupPanel();

      await send({ command: 'analyzePatterns' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'patternInsights',
          insights: expect.any(Array),
        })
      );
    });
  });

  // ----- handleExportReport -----
  describe('handleExportReport', () => {
    it('should copy report to clipboard', async () => {
      const { send } = await setupPanel();

      await send({ command: 'exportReport' });

      expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('# Report');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Retrospective Report Copied to Clipboard'
      );
    });
  });

  // ===== branch coverage: error catch blocks =====

  describe('branch coverage: handleGetPRPhase error', () => {
    it('should send error when getPRPhase throws', async () => {
      const { mockPanel, send } = await setupPanel();

      vi.spyOn(db, 'getPRPhase').mockRejectedValueOnce(new Error('DB error'));

      await send({ command: 'getPRPhase', prReference: '#err' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: expect.stringContaining('Failed to Get PR Phase'),
        })
      );
    });
  });

  describe('branch coverage: handleStartBlindedReview error', () => {
    it('should send error when startBlindedReview throws', async () => {
      const { mockPanel, send } = await setupPanel();

      vi.spyOn(db, 'getBallotsByPR').mockRejectedValueOnce(new Error('DB error'));

      await send({
        command: 'startBlindedReview',
        prReference: '#err-sbr',
        threshold: 3,
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: expect.stringContaining('Failed to Start Blinded Review'),
        })
      );
    });

    it('should error when prReference is null/undefined', async () => {
      const { mockPanel, send } = await setupPanel();

      await send({
        command: 'startBlindedReview',
        prReference: null,
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: 'Invalid PR Reference',
        })
      );
    });
  });

  describe('branch coverage: handleSubmitBallot error path', () => {
    it('should send error when ballot submission throws', async () => {
      const { mockPanel, send } = await setupPanel();

      vi.spyOn(db, 'canSubmitBallot').mockRejectedValueOnce(new Error('DB broken'));

      await send({
        command: 'submitBallot',
        ballot: {
          prReference: '#err-sub',
          decision: 'approve',
          confidence: 4,
          rationale: 'Test',
        },
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: expect.stringContaining('Ballot submission failed'),
        })
      );
    });

    it('should handle confidence < 3 when nudge_responses is undefined', async () => {
      const { mockPanel, send } = await setupPanel();
      const prRef = '#nudge-undef';
      await db.startBlindedReview(prRef, 3);

      await send({
        command: 'submitBallot',
        ballot: {
          prReference: prRef,
          decision: 'reject',
          confidence: 2,
          rationale: 'Not sure',
          // no nudge_responses at all
        },
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: 'Main Risk is Required When Confidence is Below 3',
        })
      );
    });
  });

  describe('branch coverage: handleRevealBallots error', () => {
    it('should send error when revealBallots throws', async () => {
      const { mockPanel, send } = await setupPanel();

      vi.spyOn(db, 'canRevealBallots').mockRejectedValueOnce(new Error('DB error'));

      await send({ command: 'revealBallots', prReference: '#err-rev' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: expect.stringContaining('Ballot Reveal Failed'),
        })
      );
    });
  });

  describe('branch coverage: handleGetCalibrationData error', () => {
    it('should send error when calibration data fails', async () => {
      const { mockPanel, send } = await setupPanel();

      vi.spyOn(db, 'getUserCalibrationData').mockRejectedValueOnce(new Error('DB error'));

      await send({ command: 'getCalibrationData' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: expect.stringContaining('Failed to Load Calibration Data'),
        })
      );
    });
  });

  describe('branch coverage: handleToggleThrivingItem error', () => {
    it('should send error when toggle fails', async () => {
      const { mockPanel, send } = await setupPanel();

      vi.spyOn(db, 'toggleChecklistItem').mockRejectedValueOnce(new Error('DB error'));

      await send({
        command: 'toggleThrivingItem',
        prReference: '#err-toggle',
        itemKey: 'labs_lc_1',
        checked: true,
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: expect.stringContaining('Failed to update checklist item'),
        })
      );
    });
  });

  describe('branch coverage: handleToggleTraceItem error', () => {
    it('should send error when trace toggle fails', async () => {
      const { mockPanel, send } = await setupPanel();

      vi.spyOn(db, 'toggleTraceItem').mockRejectedValueOnce(new Error('DB error'));

      await send({
        command: 'toggleTraceItem',
        itemKey: 'trace_t_1',
        checked: true,
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: expect.stringContaining('Failed to update TRACE item'),
        })
      );
    });
  });

  describe('branch coverage: handleUpdateThrivingNotes error', () => {
    it('should not throw when updateChecklistItemNotes fails', async () => {
      const { send } = await setupPanel();

      vi.spyOn(db, 'updateChecklistItemNotes').mockRejectedValueOnce(new Error('DB error'));

      // should not throw, just log
      await send({
        command: 'updateThrivingNotes',
        prReference: '#err-notes',
        itemKey: 'labs_lc_1',
        notes: 'test',
      });
    });
  });

  describe('branch coverage: handleGetThrivingAnalytics error', () => {
    it('should send error when analytics computation fails', async () => {
      const { mockPanel, send } = await setupPanel();

      vi.spyOn(db, 'getThrivingAnalytics').mockRejectedValueOnce(new Error('DB error'));

      await send({ command: 'getThrivingAnalytics' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: expect.stringContaining('Failed to load thriving analytics'),
        })
      );
    });
  });

  describe('branch coverage: handleGetThrivingChecklist error', () => {
    it('should send error when getChecklistForPR throws', async () => {
      const { mockPanel, send } = await setupPanel();

      vi.spyOn(db, 'initializeChecklistForPR').mockRejectedValueOnce(new Error('DB error'));

      await send({ command: 'getThrivingChecklist', prReference: '#err-checklist' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: expect.stringContaining('Failed to load thriving checklist'),
        })
      );
    });
  });

  describe('branch coverage: handleRefreshThrivingAutoDetect error', () => {
    it('should not throw when auto-detection fails', async () => {
      const { send } = await setupPanel();

      vi.spyOn(db, 'getThrivingTemplates').mockRejectedValueOnce(new Error('DB error'));

      // should not throw
      await send({ command: 'refreshThrivingAutoDetect', prReference: '#err-detect' });
    });
  });

  describe('branch coverage: handleGetReflectionTimeline error', () => {
    it('should send error when timeline load fails', async () => {
      const { mockPanel, send } = await setupPanel();

      vi.spyOn(db, 'getRetrospectives').mockRejectedValueOnce(new Error('DB error'));

      await send({ command: 'getReflectionTimeline', filters: {} });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: expect.stringContaining('Failed to Load Reflection Timeline'),
        })
      );
    });
  });

  describe('branch coverage: handleAnalyzePatterns error', () => {
    it('should send error when pattern analysis fails', async () => {
      const { mockPanel, send } = await setupPanel();

      const { ReflectionService } = await import('../services/ReflectionService');
      vi.mocked(ReflectionService).mockImplementationOnce(
        () =>
          ({
            detectPatterns: vi.fn().mockRejectedValue(new Error('Pattern error')),
            exportRetrospectiveReport: vi.fn(),
          }) as any
      );

      await send({ command: 'analyzePatterns' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: expect.stringContaining('Failed to Analyze Patterns'),
        })
      );
    });
  });

  describe('branch coverage: handleExportReport error', () => {
    it('should send error when export fails', async () => {
      const { mockPanel, send } = await setupPanel();

      const { ReflectionService } = await import('../services/ReflectionService');
      vi.mocked(ReflectionService).mockImplementationOnce(
        () =>
          ({
            detectPatterns: vi.fn(),
            exportRetrospectiveReport: vi.fn().mockRejectedValue(new Error('Export error')),
          }) as any
      );

      await send({ command: 'exportReport' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: expect.stringContaining('Failed to Export Report'),
        })
      );
    });
  });

  describe('branch coverage: handleSaveDecisionScheme error', () => {
    it('should send error when saving decision scheme fails', async () => {
      const { mockPanel, send } = await setupPanel();

      vi.spyOn(db, 'recordDecisionScheme').mockRejectedValueOnce(new Error('DB error'));

      await send({
        command: 'saveDecisionScheme',
        data: { scheme_type: 'consensus', rationale: 'Test' },
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: expect.stringContaining('Failed to Save Decision Scheme'),
        })
      );
    });
  });

  describe('branch coverage: handleSaveRetrospective error', () => {
    it('should send error when saving retrospective fails', async () => {
      const { mockPanel, send } = await setupPanel();

      vi.spyOn(db, 'recordRetrospective').mockRejectedValueOnce(new Error('DB error'));

      await send({
        command: 'saveRetrospective',
        data: {
          what_went_wrong: 'Test',
          what_to_improve: 'Test',
          bias_patterns: [],
        },
      });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: expect.stringContaining('Failed to Save Retrospective'),
        })
      );
    });
  });

  describe('branch coverage: handleGetRecentPRs error', () => {
    it('should send error when getRecentPRs throws', async () => {
      const { mockPanel, send } = await setupPanel();

      vi.spyOn(db, 'getRecentPRs').mockRejectedValueOnce(new Error('DB error'));

      await send({ command: 'getRecentPRs' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'error',
          message: expect.stringContaining('Failed to Load Recent PRs'),
        })
      );
    });
  });

  describe('branch coverage: handleAutoDetectPR when getCurrentBranch returns null', () => {
    it('should silently return when branchName is null', async () => {
      const { getCurrentBranch } = await import('../services/GitService');
      // mock twice: once for the constructor's auto-detect, once for our explicit call
      vi.mocked(getCurrentBranch).mockResolvedValueOnce(null).mockResolvedValueOnce(null);

      const { mockPanel } = createMockWebviewPanel();
      const extensionUri = { fsPath: '/test/extension' } as any;
      ChorusPanel.createOrShow(extensionUri, db);
      await tick();

      // the constructor auto-detect AND our explicit call both get null branch
      // so no prAutoDetected messages should be posted
      const prAutoDetectedCalls = vi
        .mocked(mockPanel.webview.postMessage)
        .mock.calls.filter((call: any[]) => call[0]?.command === 'prAutoDetected');
      expect(prAutoDetectedCalls).toHaveLength(0);

      // restore default
      vi.mocked(getCurrentBranch).mockResolvedValue('feat/pr-42-add-feature');
    });
  });

  describe('branch coverage: handleAutoDetectPR when GitHub repo detection fails', () => {
    it('should return prTitle as null when detectGitHubRepo returns null', async () => {
      const mockGitHubService = {
        detectGitHubRepo: vi.fn().mockResolvedValue(null),
        getPullRequest: vi.fn().mockResolvedValue(null),
        parsePRReference: vi.fn(),
        createPRComment: vi.fn(),
      };

      const { mockPanel, send } = await setupPanel(mockGitHubService);

      await send({ command: 'autoDetectPR' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'prAutoDetected',
          data: expect.objectContaining({
            prTitle: null,
          }),
        })
      );
    });

    it('should handle GitHub API error gracefully during PR title fetch', async () => {
      const mockGitHubService = {
        detectGitHubRepo: vi.fn().mockResolvedValue({ owner: 'test', repo: 'repo' }),
        getPullRequest: vi.fn().mockRejectedValue(new Error('API error')),
        parsePRReference: vi.fn(),
        createPRComment: vi.fn(),
      };

      const { mockPanel, send } = await setupPanel(mockGitHubService);

      await send({ command: 'autoDetectPR' });

      expect(mockPanel.webview.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'prAutoDetected',
          data: expect.objectContaining({
            prTitle: null,
          }),
        })
      );
    });
  });

  describe('branch coverage: postBallotsToGitHub workspace folders edge case', () => {
    it('should handle workspace folders being empty during short ref posting', async () => {
      const mockGitHubService = {
        detectGitHubRepo: vi.fn().mockResolvedValue(null),
        getPullRequest: vi.fn().mockResolvedValue(null),
        parsePRReference: vi.fn().mockReturnValue(null),
        createPRComment: vi.fn(),
      };

      const { send } = await setupPanel(mockGitHubService);

      const prRef = '#508';
      await db.startBlindedReview(prRef, 1);
      await db.addBallot({ ...mockBallot, pr_reference: prRef });

      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn().mockReturnValue(true),
      } as any);

      // temporarily clear workspace folders
      const origFolders = (vscode.workspace as any).workspaceFolders;
      (vscode.workspace as any).workspaceFolders = [];

      await send({ command: 'revealBallots', prReference: prRef });
      await tick();

      // should not call createPRComment since no workspace folder
      expect(mockGitHubService.createPRComment).not.toHaveBeenCalled();

      (vscode.workspace as any).workspaceFolders = origFolders;
    });
  });
});
