import * as vscode from 'vscode';
import { LocalDB, BallotEntry } from '../storage/LocalDB';
import { getGitUserInfo } from '../services/GitConfigService';
import { GitHubService } from '../services/GitHubService';
import { ThrivingService } from '../services/ThrivingService';

export class ChorusPanel {
  public static currentPanel: ChorusPanel | undefined;
  public static readonly viewType = 'chorus.panel';

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private readonly githubService: GitHubService | undefined;
  private currentPRReference: string = '';
  private readonly thrivingService: ThrivingService;

  public static createOrShow(
    extensionUri: vscode.Uri,
    db: LocalDB,
    githubService?: GitHubService
  ): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (ChorusPanel.currentPanel) {
      ChorusPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      ChorusPanel.viewType,
      'Chorus',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'media'),
          vscode.Uri.joinPath(extensionUri, 'out', 'panel'),
          vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
        ],
      }
    );

    ChorusPanel.currentPanel = new ChorusPanel(panel, extensionUri, db, githubService);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly db: LocalDB,
    githubService?: GitHubService
  ) {
    this.panel = panel;
    this.githubService = githubService;
    this.thrivingService = new ThrivingService(db);

    this.update();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'autoDetectPR':
            await this.handleAutoDetectPR();
            return;
          case 'getRecentPRs':
            await this.handleGetRecentPRs();
            return;
          case 'searchContext':
            await this.handleSearchContext(message.query);
            return;
          case 'getPRPhase':
            await this.handleGetPRPhase(message.prReference);
            return;
          case 'startBlindedReview':
            await this.handleStartBlindedReview(message);
            return;
          case 'submitBallot':
            await this.handleSubmitBallot(message.ballot);
            return;
          case 'revealBallots':
            await this.handleRevealBallots(message.prReference);
            return;
          case 'getCalibrationData':
            await this.handleGetCalibrationData();
            return;
          case 'getReflectionTimeline':
            await this.handleGetReflectionTimeline(message.filters);
            return;
          case 'analyzePatterns':
            await this.handleAnalyzePatterns();
            return;
          case 'exportReport':
            await this.handleExportReport();
            return;
          case 'saveDecisionScheme':
            await this.handleSaveDecisionScheme(message.data);
            return;
          case 'saveRetrospective':
            await this.handleSaveRetrospective(message.data);
            return;
          case 'getThrivingChecklist':
            await this.handleGetThrivingChecklist(message.prReference);
            return;
          case 'toggleThrivingItem':
            await this.handleToggleThrivingItem(message);
            return;
          case 'toggleTraceItem':
            await this.handleToggleTraceItem(message);
            return;
          case 'updateThrivingNotes':
            await this.handleUpdateThrivingNotes(message);
            return;
          case 'getThrivingAnalytics':
            await this.handleGetThrivingAnalytics();
            return;
          case 'refreshThrivingAutoDetect':
            await this.handleRefreshThrivingAutoDetect(message.prReference);
            return;
        }
      },
      null,
      this.disposables
    );

    // auto-detect PR context when panel opens
    this.handleAutoDetectPR().catch((error) => {
      console.error('Failed to auto-detect PR:', error);
    });
  }

  private async handleSearchContext(query: string): Promise<void> {
    try {
      const results = await this.db.searchContext(query);
      await this.panel.webview.postMessage({
        command: 'searchResults',
        results: results,
      });
    } catch (error) {
      console.error('Search failed:', error);
      await this.panel.webview.postMessage({
        command: 'error',
        message: 'Search failed: ' + error,
      });
    }
  }

  private async handleGetPRPhase(prReference: string): Promise<void> {
    try {
      // update current pr reference for reflection handlers
      this.currentPRReference = prReference;

      // fetch current phase for ui rendering
      const phase = await this.db.getPRPhase(prReference);
      const ballots = await this.db.getBallotsByPR(prReference);
      const canReveal = await this.db.canRevealBallots(prReference);
      const canSubmit = await this.db.canSubmitBallot(prReference);

      await this.panel.webview.postMessage({
        command: 'prPhaseUpdate',
        phaseData: {
          phase: phase,
          ballotCount: ballots.length,
          canReveal: canReveal,
          canSubmit: canSubmit,
        },
      });
    } catch (error) {
      console.error('Failed to Get PR Phase:', error);
      await this.panel.webview.postMessage({
        command: 'error',
        message: 'Failed to Get PR Phase: ' + error,
      });
    }
  }

  private async handleStartBlindedReview(message: any): Promise<void> {
    try {
      const prReference = message.prReference;
      const threshold = message.threshold || 3;

      // validate pr reference
      if (!prReference || !prReference.trim()) {
        await this.panel.webview.postMessage({
          command: 'error',
          message: 'Invalid PR Reference',
        });
        return;
      }

      // check if pr already has ballots submitted
      const existingBallots = await this.db.getBallotsByPR(prReference);

      if (existingBallots.length > 0) {
        await this.panel.webview.postMessage({
          command: 'error',
          message: 'PR Already Exists - Ballots Have Been Submitted',
        });
        return;
      }

      // initialize pr in blinded phase with threshold
      await this.db.startBlindedReview(prReference, threshold);

      await this.panel.webview.postMessage({
        command: 'blindedReviewStarted',
        success: true,
        prReference: prReference,
        threshold: threshold,
      });
    } catch (error) {
      console.error('Failed to Start Blinded Review:', error);
      await this.panel.webview.postMessage({
        command: 'error',
        message: 'Failed to Start Blinded Review: ' + error,
      });
    }
  }

  private async handleSubmitBallot(ballot: any): Promise<void> {
    try {
      // check if PR is in blinded phase
      // ballots can only be submitted during blinded phase
      const canSubmit = await this.db.canSubmitBallot(ballot.prReference);
      if (!canSubmit) {
        await this.panel.webview.postMessage({
          command: 'error',
          message: 'Ballots cannot be submitted after the reveal phase has begun',
        });
        return;
      }

      // validate nudge responses if confidence is low
      // when confidence < 3, nudge_responses with mainRisk is required
      if (ballot.confidence < 3) {
        if (!ballot.nudge_responses?.mainRisk?.trim()) {
          await this.panel.webview.postMessage({
            command: 'error',
            message: 'Main Risk is Required When Confidence is Below 3',
          });
          return;
        }
      }

      // get git user info from workspace
      // privacy-preserving: only stored, not immediately displayed
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const workspacePath = workspaceFolders?.[0]?.uri.fsPath || '';

      const userInfo = await getGitUserInfo(workspacePath);
      const authorMetadata = {
        name: userInfo?.name || 'Anonymous',
        email: userInfo?.email || '',
        timestamp: new Date().toISOString(),
      };

      // prepare ballot data with optional nudge_responses
      const ballotData: Omit<BallotEntry, 'id' | 'created_at'> = {
        pr_reference: ballot.prReference,
        decision: ballot.decision,
        confidence: ballot.confidence,
        rationale: ballot.rationale,
        author_metadata: JSON.stringify(authorMetadata),
        revealed: false,
      };

      // only include nudge_responses if present
      if (ballot.nudge_responses) {
        ballotData.nudge_responses = JSON.stringify(ballot.nudge_responses);
      }

      await this.db.addBallot(ballotData);

      await this.panel.webview.postMessage({
        command: 'ballotSubmitted',
        success: true,
      });

      // trigger thriving auto-detection after ballot submission
      this.handleRefreshThrivingAutoDetect(ballot.prReference).catch(console.error);
    } catch (error) {
      console.error('Ballot submission failed:', error);
      await this.panel.webview.postMessage({
        command: 'error',
        message: 'Ballot submission failed: ' + error,
      });
    }
  }

  private async handleRevealBallots(prReference: string): Promise<void> {
    try {
      // check if ballots can be revealed
      // phase must be blinded and threshold met
      const canReveal = await this.db.canRevealBallots(prReference);

      if (!canReveal) {
        const phase = await this.db.getPRPhase(prReference);
        const ballots = await this.db.getBallotsByPR(prReference);

        // provide specific error message based on reason
        if (phase === 'revealed') {
          await this.panel.webview.postMessage({
            command: 'error',
            message: 'Ballots Have Already Been Revealed',
          });
        } else if (phase === null) {
          await this.panel.webview.postMessage({
            command: 'error',
            message: 'PR Review Not Started - Use "Start Blinded Review" First',
          });
        } else {
          // phase is blinded but threshold not met
          await this.panel.webview.postMessage({
            command: 'error',
            message: `Cannot Reveal Ballots: Minimum Threshold Not Met (${ballots.length} ballot(s) submitted)`,
          });
        }
        return;
      }

      // reveal ballots and transition phase
      await this.db.revealBallots(prReference);
      const ballots = await this.db.getBallotsByPR(prReference);

      await this.panel.webview.postMessage({
        command: 'ballotsRevealed',
        ballots: ballots,
      });

      // attempt to post ballot summary to github (async, non-blocking)
      // this runs in background and doesn't block the reveal workflow
      this.postBallotsToGitHub(prReference, ballots).catch((error) => {
        // errors are already handled in postBallotsToGitHub
        console.error('Background GitHub post failed:', error);
      });
    } catch (error) {
      console.error('Ballot Reveal Failed:', error);
      await this.panel.webview.postMessage({
        command: 'error',
        message: 'Ballot Reveal Failed: ' + error,
      });
    }
  }

  private async handleGetCalibrationData(): Promise<void> {
    try {
      // import calibration utilities
      const { calculateCalibrationMetrics } = await import('../utils/calibration');

      // get calibration data from database
      const calibrationData = await this.db.getUserCalibrationData();

      // convert to format expected by calibration utility
      const dataPoints = calibrationData.map((point) => ({
        confidence: point.confidence,
        outcome: point.outcome_success,
        prReference: point.pr_reference,
      }));

      // calculate metrics
      const metrics = calculateCalibrationMetrics(dataPoints);

      // prepare history data for display
      const history = calibrationData.map((point) => ({
        prReference: point.pr_reference,
        confidence: point.confidence,
        outcomeType: point.outcome_type,
        accurate: point.outcome_success,
      }));

      // send data to webview
      await this.panel.webview.postMessage({
        command: 'calibrationData',
        data: {
          brierScore: metrics.brierScore,
          totalPredictions: metrics.totalPredictions,
          overallAccuracy: metrics.overallAccuracy,
          calibrationCurve: metrics.calibrationCurve,
          insights: metrics.insights,
          history: history,
        },
      });
    } catch (error) {
      console.error('Failed to Get Calibration Data:', error);
      await this.panel.webview.postMessage({
        command: 'error',
        message: 'Failed to Load Calibration Data: ' + error,
      });
    }
  }

  private async handleGetThrivingChecklist(prReference: string): Promise<void> {
    try {
      const pr = prReference || this.currentPRReference;
      if (!pr) {
        await this.panel.webview.postMessage({
          command: 'thrivingChecklistLoaded',
          data: { labsItems: [], traceItems: [], autoDetectedKeys: [] },
        });
        return;
      }
      const data = await this.thrivingService.getChecklistForPR(pr);
      await this.panel.webview.postMessage({
        command: 'thrivingChecklistLoaded',
        data,
      });
    } catch (error) {
      console.error('Failed to load thriving checklist:', error);
      await this.panel.webview.postMessage({
        command: 'error',
        message: 'Failed to load thriving checklist: ' + error,
      });
    }
  }

  private async handleToggleThrivingItem(message: any): Promise<void> {
    try {
      await this.db.toggleChecklistItem(
        message.prReference,
        message.itemKey,
        message.checked,
        message.notes
      );
      await this.panel.webview.postMessage({
        command: 'thrivingItemToggled',
        itemKey: message.itemKey,
        checked: message.checked,
      });
    } catch (error) {
      console.error('Failed to toggle thriving item:', error);
      await this.panel.webview.postMessage({
        command: 'error',
        message: 'Failed to update checklist item: ' + error,
      });
    }
  }

  private async handleToggleTraceItem(message: any): Promise<void> {
    try {
      await this.db.toggleTraceItem(message.itemKey, message.checked, message.notes);
      await this.panel.webview.postMessage({
        command: 'thrivingItemToggled',
        itemKey: message.itemKey,
        checked: message.checked,
      });
    } catch (error) {
      console.error('Failed to toggle TRACE item:', error);
      await this.panel.webview.postMessage({
        command: 'error',
        message: 'Failed to update TRACE item: ' + error,
      });
    }
  }

  private async handleUpdateThrivingNotes(message: any): Promise<void> {
    try {
      await this.db.updateChecklistItemNotes(message.prReference, message.itemKey, message.notes);
    } catch (error) {
      console.error('Failed to update thriving notes:', error);
    }
  }

  private async handleGetThrivingAnalytics(): Promise<void> {
    try {
      const analytics = await this.thrivingService.computeAnalytics();
      await this.panel.webview.postMessage({
        command: 'thrivingAnalyticsLoaded',
        data: analytics,
      });
    } catch (error) {
      console.error('Failed to load thriving analytics:', error);
      await this.panel.webview.postMessage({
        command: 'error',
        message: 'Failed to load thriving analytics: ' + error,
      });
    }
  }

  private async handleRefreshThrivingAutoDetect(prReference: string): Promise<void> {
    try {
      const pr = prReference || this.currentPRReference;
      if (!pr) return;
      const detected = await this.thrivingService.runAutoDetection(pr);
      await this.panel.webview.postMessage({
        command: 'thrivingAutoDetectComplete',
        detectedKeys: detected,
      });
    } catch (error) {
      console.error('Failed to refresh auto-detection:', error);
    }
  }

  private update(): void {
    this.panel.title = 'Chorus';
    this.panel.webview.html = this.getHtmlForWebview();
  }

  /* v8 ignore start */
  private getHtmlForWebview(): string {
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js')
    );

    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css')
    );

    const stylesUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'styles.css')
    );

    const codiconsUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        'node_modules',
        '@vscode',
        'codicons',
        'dist',
        'codicon.css'
      )
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleUri}" rel="stylesheet">
	<link href="${stylesUri}" rel="stylesheet">
	<link href="${codiconsUri}" rel="stylesheet">
	<title>Chorus</title>
</head>
<body>
	<div class="chorus-panel">
		<nav class="tab-nav" role="tablist">
			<button class="tab-button active" data-tab="context" role="tab" aria-selected="true"><span class="codicon codicon-search"></span> Context</button>
			<button class="tab-button" data-tab="evidence" role="tab" aria-selected="false"><span class="codicon codicon-beaker"></span> Evidence</button>
			<button class="tab-button" data-tab="equity" role="tab" aria-selected="false"><span class="codicon codicon-law"></span> Equity</button>
			<button class="tab-button" data-tab="calibration" role="tab" aria-selected="false"><span class="codicon codicon-graph-line"></span> Calibration</button>
			<button class="tab-button" data-tab="reflection" role="tab" aria-selected="false"><span class="codicon codicon-mirror"></span> Reflection</button>
			<button class="tab-button" data-tab="thriving" role="tab" aria-selected="false"><span class="codicon codicon-heart"></span> Thriving</button>
		</nav>

		<div class="tab-content">
			<div id="context-tab" class="tab-pane active" role="tabpanel">
				<div class="search-section">
					<input type="text" id="context-search" placeholder="Search context..." aria-label="Search context">
					<button id="search-button">Search</button>
				</div>
				<div id="context-results" class="results-section">
					<div class="empty-state">
						<div class="empty-state-icon">$(search)</div>
						<h3>Search for Context</h3>
						<p>Search for commits, documentation, or related PRs to inform your review</p>
						<small class="empty-state-hint">Tip: Use keywords like "auth", "performance", or file names</small>
					</div>
				</div>
			</div>

			<div id="evidence-tab" class="tab-pane" role="tabpanel">
				<form id="evidence-form" class="evidence-form">
					<div class="form-group">
						<label for="tests-field">Tests (required):</label>
						<textarea id="tests-field" required placeholder="Link to test files or describe test coverage"></textarea>
					</div>
					<div class="form-group">
						<label for="benchmarks-field">Benchmarks:</label>
						<textarea id="benchmarks-field" placeholder="Performance metrics or N/A"></textarea>
					</div>
					<div class="form-group">
						<label for="spec-field">Spec/ADR:</label>
						<textarea id="spec-field" placeholder="Link to specification or architectural decision record"></textarea>
					</div>
					<div class="form-group">
						<label for="risk-field">Risk Notes (required):</label>
						<textarea id="risk-field" required placeholder="Security, breaking changes, or other risks"></textarea>
					</div>
					<button type="submit">Generate Evidence Block</button>
				</form>
			</div>

			<div id="equity-tab" class="tab-pane" role="tabpanel">
				<!-- PR Auto-Detection Banner -->
				<div id="pr-auto-detect-banner" class="info-banner" style="display: none;">
					<span class="info-icon">$(info)</span>
					<span id="pr-auto-detect-text"></span>
					<button id="use-detected-pr" class="link-button">Use this PR</button>
				</div>

				<!-- Recent PRs Dropdown -->
				<div class="form-group">
					<label for="recent-prs-dropdown">
						Recent PRs
						<span class="info-tooltip" title="Quick access to your 10 most recent PRs">$(info)</span>
					</label>
					<select id="recent-prs-dropdown" class="recent-prs-select">
						<option value="">Select a recent PR...</option>
					</select>
				</div>

				<!-- Phase indicator section -->
				<div id="phase-section" class="phase-section">
					<p class="equity-help-text">Enter a PR Reference Below to Begin</p>
				</div>

				<!-- Start review button -->
				<button id="start-review-button" class="primary-button" style="display: none;">Start Blinded Review</button>

				<!-- Ballot submission form -->
				<form id="ballot-form" class="ballot-form">
					<div class="form-group">
						<label for="pr-reference">
							PR Reference
							<span class="info-tooltip" title="Enter PR number (e.g., #123) or full GitHub URL">$(info)</span>
						</label>
						<input type="text" id="pr-reference" required placeholder="e.g., #123 or PR URL" aria-describedby="pr-help">
						<small id="pr-help" class="equity-help-text">Enter PR number or URL to check review status</small>
					</div>
					<div class="form-group">
						<label for="decision">Decision:</label>
						<select id="decision" required>
							<option value="">Select decision</option>
							<option value="approve">Approve</option>
							<option value="neutral">Neutral</option>
							<option value="reject">Reject</option>
						</select>
					</div>
					<div class="form-group">
						<label for="confidence">
							Confidence (1-5)
							<span class="info-tooltip" title="Rate 1-5 how certain you are. 1=Low confidence, 3=Medium, 5=High confidence">$(info)</span>
						</label>
						<div class="confidence-input-wrapper">
							<input type="range" id="confidence" min="1" max="5" value="3" aria-valuemin="1" aria-valuemax="5" aria-valuenow="3">
							<span id="confidence-value" aria-live="polite">3 - Medium</span>
						</div>
						<div id="confidence-hint" class="hint-message" style="display: none;"></div>
					</div>
					<div class="form-group">
						<label for="rationale">
							Rationale
							<span class="info-tooltip" title="Provide evidence-based reasoning for your decision">$(info)</span>
						</label>
						<textarea id="rationale" required placeholder="Brief explanation of your decision" aria-describedby="rationale-help"></textarea>
						<small id="rationale-help" class="equity-help-text">Provide reasoning for your decision</small>
						<div class="character-count" id="rationale-count">0 characters</div>
					</div>

					<!-- Elaboration Nudges (only shown during blinded phase) -->
					<div id="nudge-section" class="nudge-section" style="display: none;">
						<h4 class="nudge-header">Reflection Prompts</h4>
						<small class="equity-help-text">These questions help ensure thorough consideration and reduce groupthink</small>

						<div class="form-group">
							<label class="checkbox-label">
								<input type="checkbox" id="nudge-alternatives">
								Have You Considered Alternative Approaches?
							</label>
							<small class="equity-help-text">Thinking about alternatives helps counter confirmation bias</small>
						</div>

						<div class="form-group">
							<label for="nudge-main-risk">What's the Main Risk You're Concerned About?</label>
							<input type="text" id="nudge-main-risk" placeholder="e.g., Performance degradation, breaking changes..." aria-describedby="risk-help">
							<small id="risk-help" class="equity-help-text">Required if confidence is below 3 - helps surface hidden concerns</small>
						</div>

						<div class="form-group">
							<label for="nudge-dissent">Any Dissenting Views Worth Noting? (Optional)</label>
							<textarea id="nudge-dissent" placeholder="Perspectives that differ from the majority or your initial reaction..." aria-describedby="dissent-help"></textarea>
							<small id="dissent-help" class="equity-help-text">Capturing minority views strengthens decision quality</small>
						</div>
					</div>
					<button type="submit">Submit Quiet Ballot</button>
				</form>

				<!-- Reveal button -->
				<button id="reveal-button" class="reveal-button" disabled aria-label="Reveal Ballots">Reveal Results</button>

				<!-- Status section for ballot display -->
				<div id="ballot-status" class="status-section"></div>
			</div>

			<div id="calibration-tab" class="tab-pane" role="tabpanel">
				<!-- Privacy notice -->
				<div class="privacy-notice">
					<h3>Personal Calibration Dashboard</h3>
					<p class="equity-help-text">All calibration data is stored locally and visible only to you. Never shared.</p>
				</div>

				<!-- Statistics section -->
				<div id="calibration-stats" class="calibration-stats">
					<div class="stat-card">
						<h4>Brier Score</h4>
						<div id="brier-score" class="stat-value">--</div>
						<small class="equity-help-text">Lower is better (0-1 scale)</small>
					</div>
					<div class="stat-card">
						<h4>Total Predictions</h4>
						<div id="total-predictions" class="stat-value">--</div>
						<small class="equity-help-text">Ballots with confirmed outcomes</small>
					</div>
					<div class="stat-card">
						<h4>Overall Accuracy</h4>
						<div id="overall-accuracy" class="stat-value">--</div>
						<small class="equity-help-text">Correct predictions</small>
					</div>
				</div>

				<!-- Calibration curve chart -->
				<div class="chart-section">
					<h4>Calibration Curve</h4>
					<small class="equity-help-text">How your confidence levels compare to actual outcomes</small>
					<div id="calibration-chart" class="chart-container"></div>
				</div>

				<!-- Insights section -->
				<div class="insights-section">
					<h4>Insights</h4>
					<div id="calibration-insights" class="insights-list"></div>
				</div>

				<!-- Outcome history table -->
				<div class="history-section">
					<h4>Outcome History</h4>
					<button id="refresh-calibration" class="primary-button">Refresh Data</button>
					<div id="outcome-history" class="history-table"></div>
				</div>
			</div>

			<div id="reflection-tab" class="tab-pane" role="tabpanel">
				<div class="reflection-header">
					<h3>Team Reflection Dashboard</h3>
					<p class="equity-help-text">Analyze decision patterns and learn from past reviews to build adaptive team culture</p>
				</div>

				<!-- Decision Timeline Section -->
				<div class="reflection-section">
					<h4>Decision Timeline</h4>
					<div class="filter-controls">
						<label for="reflection-date-start">Start Date:</label>
						<input type="date" id="reflection-date-start" class="date-input">
						<label for="reflection-date-end">End Date:</label>
						<input type="date" id="reflection-date-end" class="date-input">
						<button id="filter-timeline" class="secondary-button">Filter</button>
						<button id="clear-filters" class="secondary-button">Clear</button>
					</div>
					<div id="decision-timeline" class="timeline-container">
						<p class="placeholder-text">No decision data available yet. Complete a review with ballot reveal to see timeline.</p>
					</div>
				</div>

				<!-- Pattern Detection Section -->
				<div class="reflection-section">
					<h4>Pattern Detection</h4>
					<button id="analyze-patterns" class="primary-button">Analyze Patterns</button>
					<div id="pattern-insights" class="insights-container">
						<p class="placeholder-text">Click "Analyze Patterns" to detect potential issues and recommendations</p>
					</div>
				</div>

				<!-- Scheme Distribution Section -->
				<div class="reflection-section">
					<h4>Decision Scheme Distribution</h4>
					<p class="equity-help-text">Shows which decision rules your team uses most often</p>
					<div id="scheme-distribution" class="chart-container">
						<p class="placeholder-text">No scheme data available yet. Tag decision schemes during ballot reveals to see distribution.</p>
					</div>
				</div>

				<!-- Thriving Dimensions Section -->
				<div class="reflection-section">
					<h4><span class="codicon codicon-heart"></span> Thriving Dimensions</h4>
					<p class="equity-help-text">LABS dimension completion rates across your reviews</p>
					<div id="thriving-dimension-chart" class="dimension-chart">
						<p class="placeholder-text">Complete thriving checklists during reviews to see dimension data here.</p>
					</div>
				</div>

				<!-- Export Section -->
				<div class="reflection-section">
					<h4>Export Retrospective Report</h4>
					<p class="equity-help-text">Generate a markdown report with all retrospectives and insights</p>
					<button id="export-report" class="primary-button">Export Report</button>
				</div>
			</div>

			<div id="thriving-tab" class="tab-pane" role="tabpanel">
				<div class="thriving-section">
					<div class="section-header">
						<span class="codicon codicon-heart"></span>
						<span class="section-header-label">Developer Thriving Checklist</span>
						<button id="refresh-thriving" class="section-header-action" title="Refresh auto-detection">
							<span class="codicon codicon-refresh"></span> Refresh
						</button>
					</div>
					<p class="equity-help-text mb-md">Based on Dr. Cat Hicks' LABS framework. Check items as you complete them during your review.</p>

					<div id="thriving-labs-section">
						<div id="dimension-learning_culture" class="dimension-group">
							<div class="dimension-header">
								<h4>Learning Culture</h4>
								<span id="progress-learning_culture" class="dimension-progress">0/0</span>
							</div>
							<div id="items-learning_culture" class="checklist-items"></div>
						</div>
						<div id="dimension-agency" class="dimension-group">
							<div class="dimension-header">
								<h4>Agency</h4>
								<span id="progress-agency" class="dimension-progress">0/0</span>
							</div>
							<div id="items-agency" class="checklist-items"></div>
						</div>
						<div id="dimension-belonging" class="dimension-group">
							<div class="dimension-header">
								<h4>Belonging</h4>
								<span id="progress-belonging" class="dimension-progress">0/0</span>
							</div>
							<div id="items-belonging" class="checklist-items"></div>
						</div>
						<div id="dimension-self_efficacy" class="dimension-group">
							<div class="dimension-header">
								<h4>Self-Efficacy</h4>
								<span id="progress-self_efficacy" class="dimension-progress">0/0</span>
							</div>
							<div id="items-self_efficacy" class="checklist-items"></div>
						</div>
					</div>

					<div class="trace-checklist">
						<div class="section-header">
							<span class="codicon codicon-shield"></span>
							<span class="section-header-label">TRACE Principles (Team-Wide)</span>
						</div>
						<p class="equity-help-text mb-md">Healthy measurement principles. These apply across all reviews.</p>
						<div id="trace-items" class="checklist-items"></div>
					</div>
				</div>
			</div>

		</div>
		<div id="toast-container"></div>
	</div>

	<!-- Decision Scheme Modal -->
	<div id="decision-scheme-modal" class="modal" style="display: none;">
		<div class="modal-content">
			<h3>How Did We Decide?</h3>
			<p class="modal-description">Before revealing ballots, tag which decision rule was used for this PR. This helps track which schemes work best.</p>

			<form id="decision-scheme-form">
				<div class="form-group">
					<label for="scheme-type">Decision Scheme:</label>
					<select id="scheme-type" required>
						<option value="">Select scheme...</option>
						<option value="consensus">Consensus - Everyone agreed (or agreed to disagree)</option>
						<option value="truth_wins">Truth Wins - Evidence/expert opinion prevailed</option>
						<option value="majority">Majority Rules - Most reviewers agreed</option>
						<option value="expert_veto">Expert Veto - Senior/expert reviewer made final call</option>
						<option value="unanimous">Unanimous - Complete agreement required</option>
						<option value="custom">Custom - Custom scheme (specify below)</option>
					</select>
				</div>

				<div class="form-group" id="custom-scheme-group" style="display: none;">
					<label for="custom-scheme-name">Custom Scheme Name:</label>
					<input type="text" id="custom-scheme-name" placeholder="e.g., Technical Lead Approval">
				</div>

				<div class="form-group">
					<label for="scheme-rationale">Why did this decision rule fit this PR?</label>
					<textarea id="scheme-rationale" required placeholder="e.g., High-risk change required expert review..." rows="3"></textarea>
				</div>

				<div class="modal-buttons">
					<button type="button" id="scheme-cancel" class="secondary-button">Cancel</button>
					<button type="submit" class="primary-button">Save & Reveal</button>
				</div>
			</form>
		</div>
	</div>

	<!-- Retrospective Modal -->
	<div id="retrospective-modal" class="modal" style="display: none;">
		<div class="modal-content">
			<h3>Reflection: Post-Merge Retrospective</h3>
			<p class="modal-description">This PR had issues after merge. Take a moment to reflect on what happened and how to improve.</p>

			<form id="retrospective-form">
				<div class="form-group">
					<label for="retro-what-wrong">What went wrong?</label>
					<textarea id="retro-what-wrong" required placeholder="Describe what happened..." rows="3"></textarea>
				</div>

				<div class="form-group">
					<label for="retro-what-improve">What could we improve in our review process?</label>
					<textarea id="retro-what-improve" required placeholder="Process improvements, tools, communication..." rows="3"></textarea>
				</div>

				<div class="form-group">
					<label>Bias patterns noticed (check all that apply):</label>
					<div class="checkbox-group">
						<label class="checkbox-label">
							<input type="checkbox" name="bias" value="groupthink">
							Groupthink (everyone agreed too quickly)
						</label>
						<label class="checkbox-label">
							<input type="checkbox" name="bias" value="hidden_profile">
							Hidden Profile (important info not surfaced)
						</label>
						<label class="checkbox-label">
							<input type="checkbox" name="bias" value="status_bias">
							Status Bias (deferred to senior without evidence)
						</label>
						<label class="checkbox-label">
							<input type="checkbox" name="bias" value="overconfidence">
							Overconfidence (high confidence but wrong outcome)
						</label>
						<label class="checkbox-label">
							<input type="checkbox" name="bias" value="other">
							Other (specify below)
						</label>
					</div>
				</div>

				<div class="form-group" id="other-bias-group" style="display: none;">
					<label for="other-bias-description">Describe other bias:</label>
					<input type="text" id="other-bias-description" placeholder="e.g., Time pressure, insufficient testing">
				</div>

				<div class="modal-buttons">
					<button type="button" id="retro-dismiss" class="secondary-button">Dismiss</button>
					<button type="submit" class="primary-button">Save Retrospective</button>
				</div>
			</form>
		</div>
	</div>

	<script src="${scriptUri}"></script>
</body>
</html>`;
  }
  /* v8 ignore stop */

  /**
   * Formats a ballot summary comment for GitHub PR posting.
   *
   * Generates a markdown-formatted summary of ballot results including:
   * - Review phase completion timestamp
   * - Total ballot count
   * - Decision distribution (approve/neutral/reject)
   * - Confidence level distribution
   * - Average confidence score
   * - Chorus branding footer
   *
   * @param ballots - Array of ballot entries to summarize
   * @returns Formatted markdown string for GitHub comment
   */
  private formatBallotSummary(ballots: BallotEntry[]): string {
    const timestamp = new Date().toISOString();
    const totalCount = ballots.length;

    // calculate decision distribution
    const approveCount = ballots.filter((b) => b.decision === 'approve').length;
    const neutralCount = ballots.filter((b) => b.decision === 'neutral').length;
    const rejectCount = ballots.filter((b) => b.decision === 'reject').length;

    // calculate percentages
    const approvePercent = totalCount > 0 ? Math.round((approveCount / totalCount) * 100) : 0;
    const neutralPercent = totalCount > 0 ? Math.round((neutralCount / totalCount) * 100) : 0;
    const rejectPercent = totalCount > 0 ? Math.round((rejectCount / totalCount) * 100) : 0;

    // calculate confidence distribution
    const highConfidence = ballots.filter((b) => b.confidence >= 4).length;
    const mediumConfidence = ballots.filter((b) => b.confidence === 3).length;
    const lowConfidence = ballots.filter((b) => b.confidence <= 2).length;

    // calculate average confidence
    const avgConfidence =
      totalCount > 0
        ? (ballots.reduce((sum, b) => sum + b.confidence, 0) / totalCount).toFixed(1)
        : '0.0';

    // aggregate nudge responses
    let nudgeSummary = '';
    const ballotsWithNudges = ballots.filter(
      (b) => b.nudge_responses && b.nudge_responses !== '{}'
    );

    if (ballotsWithNudges.length > 0) {
      const risks: string[] = [];
      const dissentingViews: string[] = [];
      let consideredAlternativesCount = 0;

      ballotsWithNudges.forEach((ballot) => {
        try {
          const nudges = JSON.parse(ballot.nudge_responses || '{}');

          if (nudges.consideredAlternatives) {
            consideredAlternativesCount++;
          }

          if (nudges.mainRisk && nudges.mainRisk.trim()) {
            risks.push(nudges.mainRisk.trim());
          }

          if (nudges.dissentingViews && nudges.dissentingViews.trim()) {
            dissentingViews.push(nudges.dissentingViews.trim());
          }
        } catch (error) {
          // skip malformed nudge responses
          console.warn('Failed to parse nudge_responses:', error);
        }
      });

      nudgeSummary = '\n### Key Concerns Raised\n';

      if (risks.length > 0) {
        nudgeSummary += risks.map((risk) => `- ${risk}`).join('\n');
      } else {
        nudgeSummary += '- No specific risks identified';
      }

      if (dissentingViews.length > 0) {
        nudgeSummary += '\n\n### Dissenting Views\n';
        nudgeSummary += dissentingViews.map((view) => `- ${view}`).join('\n');
      }

      nudgeSummary += `\n\n*${consideredAlternativesCount} out of ${totalCount} reviewers considered alternative approaches*\n`;
    }

    return `## 🎭 Chorus Evidence - Blinded Review Results

**Review Phase Completed**: ${timestamp}
**Ballots Submitted**: ${totalCount}

### Review Summary
- ✅ Approve: ${approveCount} (${approvePercent}%)
- ⏸️ Neutral: ${neutralCount} (${neutralPercent}%)
- ❌ Reject: ${rejectCount} (${rejectPercent}%)

### Confidence Distribution
- High (4-5): ${highConfidence}
- Medium (3): ${mediumConfidence}
- Low (1-2): ${lowConfidence}

**Average Confidence**: ${avgConfidence}/5
${nudgeSummary}
---
*Posted by [Chorus Evidence](https://github.com/cross-stack/chorus) - Evidence-first, bias-aware code review*`;
  }

  /**
   * Posts ballot summary to GitHub PR as a comment.
   *
   * Implements privacy-first GitHub integration with:
   * - User permission prompt before posting
   * - Auto-post setting respect
   * - Duplicate post prevention
   * - PR reference parsing and validation
   * - Error handling with user-friendly messages
   *
   * Workflow:
   * 1. Check if already posted (prevent duplicates)
   * 2. Parse PR reference to extract owner/repo/number
   * 3. Detect GitHub repo from workspace (for short refs like #123)
   * 4. Ask user permission (unless auto-post enabled)
   * 5. Format ballot summary comment
   * 6. Post comment via GitHubService
   * 7. Store comment URL in database
   * 8. Show success notification
   *
   * @param prReference - PR reference string (e.g., "owner/repo#123" or "#123")
   * @param ballots - Array of ballot entries to summarize
   * @returns Promise that resolves when posting completes or is cancelled
   */
  private async postBallotsToGitHub(prReference: string, ballots: BallotEntry[]): Promise<void> {
    // check if github service is available
    if (!this.githubService) {
      console.log('ChorusPanel: GitHubService not available, skipping ballot post');
      return;
    }

    try {
      // check if already posted to prevent duplicates
      const alreadyPosted = await this.db.isPostedToGitHub(prReference);
      if (alreadyPosted) {
        console.log(`ChorusPanel: Ballots already posted to GitHub for ${prReference}`);
        return;
      }

      // parse pr reference
      let owner: string;
      let repo: string;
      let prNumber: number;

      // check if it's a short reference like #123
      if (prReference.match(/^#(\d+)$/)) {
        const match = prReference.match(/^#(\d+)$/);
        if (!match) {
          console.error('ChorusPanel: Invalid PR reference format');
          return;
        }

        prNumber = parseInt(match[1], 10);

        // detect github repo from workspace
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
          console.error('ChorusPanel: No workspace folder found for repo detection');
          return;
        }

        const githubRepo = await this.githubService.detectGitHubRepo(
          workspaceFolders[0].uri.fsPath
        );
        if (!githubRepo) {
          console.error('ChorusPanel: Could not detect GitHub repository');
          vscode.window.showWarningMessage(
            'Could Not Detect GitHub Repository - Ballots Not Posted'
          );
          return;
        }

        owner = githubRepo.owner;
        repo = githubRepo.repo;
      } else {
        // parse full reference like owner/repo#123
        const parsed = this.githubService.parsePRReference(prReference);
        if (!parsed) {
          console.error(`ChorusPanel: Invalid PR reference format: ${prReference}`);
          return;
        }

        owner = parsed.owner;
        repo = parsed.repo;
        prNumber = parsed.number;
      }

      // check auto-post setting
      const config = vscode.workspace.getConfiguration('chorus');
      const autoPost = config.get<boolean>('autoPostBallots', false);

      // ask user permission unless auto-post is enabled
      if (!autoPost) {
        const selection = await vscode.window.showInformationMessage(
          `Post Ballot Summary to GitHub PR #${prNumber}?`,
          { modal: true },
          'Post',
          'Cancel'
        );

        if (selection !== 'Post') {
          console.log('ChorusPanel: User cancelled ballot posting');
          return;
        }
      }

      // format ballot summary
      const commentBody = this.formatBallotSummary(ballots);

      // post comment to github
      await this.githubService.createPRComment(owner, repo, prNumber, commentBody);

      // construct comment url
      const commentUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;

      // mark as posted in database
      await this.db.markBallotsPostedToGitHub(prReference, commentUrl);

      // show success notification
      vscode.window
        .showInformationMessage(`Ballot Summary Posted to GitHub PR #${prNumber}`, 'View PR')
        .then((selection) => {
          if (selection === 'View PR') {
            vscode.env.openExternal(vscode.Uri.parse(commentUrl));
          }
        });

      console.log(`ChorusPanel: Ballot summary posted to ${commentUrl}`);
    } catch (error) {
      console.error('ChorusPanel: Failed to post ballots to GitHub:', error);
      vscode.window.showErrorMessage(
        `Failed to Post Ballots to GitHub: ${error instanceof Error ? error.message : 'Unknown Error'}`
      );
    }
  }

  private async handleGetReflectionTimeline(filters: any): Promise<void> {
    try {
      // query retrospectives and schemes with filters
      const retrospectives = await this.db.getRetrospectives(filters);
      const timeline = await Promise.all(
        retrospectives.map(async (retro) => {
          const scheme = await this.db.getDecisionScheme(retro.pr_id);
          return { ...retro, scheme };
        })
      );

      await this.panel.webview.postMessage({
        command: 'reflectionTimeline',
        timeline,
      });
    } catch (error) {
      console.error('Failed to Get Reflection Timeline:', error);
      await this.panel.webview.postMessage({
        command: 'error',
        message: 'Failed to Load Reflection Timeline: ' + error,
      });
    }
  }

  private async handleAnalyzePatterns(): Promise<void> {
    try {
      const { ReflectionService } = await import('../services/ReflectionService');
      const service = new ReflectionService(this.db);
      const insights = await service.detectPatterns();

      await this.panel.webview.postMessage({
        command: 'patternInsights',
        insights,
      });

      // Also send thriving analytics for reflection tab
      this.handleGetThrivingAnalytics().catch(console.error);
    } catch (error) {
      console.error('Failed to Analyze Patterns:', error);
      await this.panel.webview.postMessage({
        command: 'error',
        message: 'Failed to Analyze Patterns: ' + error,
      });
    }
  }

  private async handleExportReport(): Promise<void> {
    try {
      const { ReflectionService } = await import('../services/ReflectionService');
      const service = new ReflectionService(this.db);
      const report = await service.exportRetrospectiveReport();

      const vscode = await import('vscode');
      await vscode.env.clipboard.writeText(report);
      vscode.window.showInformationMessage('Retrospective Report Copied to Clipboard');
    } catch (error) {
      console.error('Failed to Export Report:', error);
      await this.panel.webview.postMessage({
        command: 'error',
        message: 'Failed to Export Report: ' + error,
      });
    }
  }

  private async handleSaveDecisionScheme(data: any): Promise<void> {
    try {
      await this.db.recordDecisionScheme(
        this.currentPRReference,
        data.scheme_type,
        data.rationale,
        data.custom_scheme_name
      );

      await this.panel.webview.postMessage({
        command: 'decisionSchemeSaved',
      });

      // trigger thriving auto-detection after saving decision scheme
      this.handleRefreshThrivingAutoDetect(this.currentPRReference).catch(console.error);
    } catch (error) {
      console.error('Failed to Save Decision Scheme:', error);
      await this.panel.webview.postMessage({
        command: 'error',
        message: 'Failed to Save Decision Scheme: ' + error,
      });
    }
  }

  private async handleSaveRetrospective(data: any): Promise<void> {
    try {
      await this.db.recordRetrospective(this.currentPRReference, 'manual', {
        what_went_wrong: data.what_went_wrong,
        what_to_improve: data.what_to_improve,
        bias_patterns: data.bias_patterns,
      });

      await this.panel.webview.postMessage({
        command: 'retrospectiveSaved',
      });

      // trigger thriving auto-detection after saving retrospective
      this.handleRefreshThrivingAutoDetect(this.currentPRReference).catch(console.error);
    } catch (error) {
      console.error('Failed to Save Retrospective:', error);
      await this.panel.webview.postMessage({
        command: 'error',
        message: 'Failed to Save Retrospective: ' + error,
      });
    }
  }

  /**
   * Auto-detects PR context from current git branch.
   *
   * Workflow:
   * 1. Get current branch name from workspace
   * 2. Extract PR number from branch name (if matches common patterns)
   * 3. Search local database for matching PR
   * 4. Query GitHub API if PR not found locally
   * 5. Send detected PR info to webview for auto-population
   */
  private async handleAutoDetectPR(): Promise<void> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        return;
      }

      const workspacePath = workspaceFolders[0].uri.fsPath;

      // get current branch
      const { getCurrentBranch, extractPRNumberFromBranch } = await import(
        '../services/GitService'
      );
      const branchName = await getCurrentBranch(workspacePath);

      if (!branchName) {
        return;
      }

      // extract PR number from branch name
      const prNumber = extractPRNumberFromBranch(branchName);
      if (!prNumber) {
        // send branch info without PR match
        await this.panel.webview.postMessage({
          command: 'prAutoDetected',
          data: {
            branch: branchName,
            prReference: null,
            prTitle: null,
          },
        });
        return;
      }

      // construct PR reference
      const prReference = `#${prNumber}`;

      // check if PR exists in database
      const phase = await this.db.getPRPhase(prReference);
      const ballots = await this.db.getBallotsByPR(prReference);

      // try to get PR title from GitHub if service available
      let prTitle: string | null = null;
      if (this.githubService) {
        try {
          const githubRepo = await this.githubService.detectGitHubRepo(workspacePath);
          if (githubRepo) {
            const prData = await this.githubService.getPullRequest(
              githubRepo.owner,
              githubRepo.repo,
              parseInt(prNumber, 10)
            );
            prTitle = prData?.title || null;
          }
        } catch (error) {
          console.log('Could not fetch PR title from GitHub:', error);
        }
      }

      // send detected PR info to webview
      await this.panel.webview.postMessage({
        command: 'prAutoDetected',
        data: {
          branch: branchName,
          prReference,
          prTitle,
          existsInDB: phase !== null,
          ballotCount: ballots.length,
        },
      });
    } catch (error) {
      console.error('Failed to auto-detect PR:', error);
      // silently fail - auto-detect is a convenience feature
    }
  }

  /**
   * Retrieves recent PRs that the user has reviewed.
   *
   * Returns up to 10 most recent PRs ordered by last activity.
   * Includes PR reference, title (if available), ballot count, and last action time.
   */
  private async handleGetRecentPRs(): Promise<void> {
    try {
      const recentPRs = await this.db.getRecentPRs(10);

      await this.panel.webview.postMessage({
        command: 'recentPRs',
        data: recentPRs,
      });
    } catch (error) {
      console.error('Failed to get recent PRs:', error);
      await this.panel.webview.postMessage({
        command: 'error',
        message: 'Failed to Load Recent PRs: ' + error,
      });
    }
  }

  public dispose(): void {
    ChorusPanel.currentPanel = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const x = this.disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }
}
