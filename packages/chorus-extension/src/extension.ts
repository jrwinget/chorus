import * as vscode from 'vscode';
import { ChorusPanel } from './panel/ChorusPanel';
import { LocalDB, ContextEntry, EvidenceEntry } from './storage/LocalDB';
import { IncrementalIndexer } from './services/IncrementalIndexer';
import { RelatedContextProvider } from './codelens/RelatedContextProvider';
import { ContextTreeProvider } from './views/ContextTreeProvider';
import { ContextHoverProvider } from './providers/ContextHoverProvider';
import { WelcomePanel } from './walkthrough/WelcomePanel';
import { Indexer } from './services/Indexer';
import { validateEvidence } from './utils/evidenceValidation';
import { EvidenceStatus } from './types/evidence';
import { GitHubService } from './services/GitHubService';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('Activating Chorus extension...');

  try {
    // initialize storage
    console.log('Creating LocalDB instance...');
    const db = new LocalDB(context.globalStorageUri.fsPath);
    console.log('Initializing database...');
    await db.initialize();
    console.log('Database initialized successfully');

    // initialize github service
    console.log('Creating GitHubService instance...');
    const githubService = new GitHubService(context);
    await githubService.loadToken();
    console.log('GitHubService initialized successfully');

    // create status bar item for PR context
    console.log('Creating Chorus status bar item...');
    const chorusStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    chorusStatusBarItem.command = 'chorus.showPanel';
    chorusStatusBarItem.text = '$(organization) Chorus';
    chorusStatusBarItem.tooltip = 'Open Chorus panel';
    chorusStatusBarItem.show();

    // create separate status bar item for indexing progress
    console.log('Creating indexing status bar item...');
    const indexStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99
    );
    indexStatusBarItem.command = 'chorus.showIndexStatus';
    indexStatusBarItem.text = '$(sync~spin) Indexing...';
    indexStatusBarItem.tooltip = 'Chorus is indexing workspace for context discovery';
    indexStatusBarItem.hide(); // initially hidden, shown during indexing

    // function to update status bar with PR context
    async function updateStatusBarWithPRContext() {
      try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
          chorusStatusBarItem.text = '$(organization) Chorus';
          chorusStatusBarItem.tooltip = 'Open Chorus panel';
          return;
        }

        const workspacePath = workspaceFolders[0].uri.fsPath;
        const { getCurrentBranch, extractPRNumberFromBranch } = await import(
          './services/GitService'
        );

        const branchName = await getCurrentBranch(workspacePath);
        if (!branchName) {
          chorusStatusBarItem.text = '$(organization) Chorus';
          chorusStatusBarItem.tooltip = 'Open Chorus panel';
          return;
        }

        const prNumber = extractPRNumberFromBranch(branchName);
        if (prNumber) {
          const prReference = `#${prNumber}`;
          const phase = await db.getPRPhase(prReference);
          const ballots = await db.getBallotsByPR(prReference);

          if (phase === 'blinded') {
            chorusStatusBarItem.text = `$(lock) Chorus: ${prReference} (${ballots.length} ballots)`;
            chorusStatusBarItem.tooltip = `Reviewing ${prReference} - Blinded phase - Click to open panel`;
          } else if (phase === 'revealed') {
            chorusStatusBarItem.text = `$(eye) Chorus: ${prReference} (revealed)`;
            chorusStatusBarItem.tooltip = `${prReference} ballots revealed - Click to open panel`;
          } else {
            chorusStatusBarItem.text = `$(organization) Chorus: ${prReference}`;
            chorusStatusBarItem.tooltip = `Branch detected: ${branchName} - Click to start review`;
          }
        } else {
          chorusStatusBarItem.text = `$(organization) Chorus`;
          chorusStatusBarItem.tooltip = `Branch: ${branchName} - Click to open panel`;
        }
      } catch (error) {
        console.error('Failed to update status bar:', error);
        chorusStatusBarItem.text = '$(organization) Chorus';
        chorusStatusBarItem.tooltip = 'Open Chorus panel';
      }
    }

    // update status bar initially and when workspace changes
    updateStatusBarWithPRContext().catch(console.error);

    // initialize incremental indexer
    console.log('Creating IncrementalIndexer instance...');
    const incrementalIndexer = new IncrementalIndexer(db, indexStatusBarItem);

    // start file watchers for incremental updates
    console.log('Starting file watchers...');
    await incrementalIndexer.startWatching();

    // start background indexing (non-blocking)
    console.log('Starting background workspace indexing...');
    incrementalIndexer.indexIncrementally().catch((err) => {
      console.error('Failed to index workspace:', err);
      vscode.window.showWarningMessage(
        'Chorus: Failed to Index Workspace. Click Status Bar to Retry'
      );
    });

    // register panel command
    console.log('Registering chorus.showPanel command...');
    const panelCommand = vscode.commands.registerCommand('chorus.showPanel', () => {
      console.log('chorus.showPanel command triggered');
      try {
        ChorusPanel.createOrShow(context.extensionUri, db, githubService);
      } catch (error) {
        console.error('Failed to show Chorus panel:', error);
        vscode.window.showErrorMessage(
          `Failed to Show Chorus Panel: ${error instanceof Error ? error.message : 'Unknown Error'}`
        );
      }
    });

    // register add evidence command
    console.log('Registering chorus.addEvidence command...');
    const addEvidenceCommand = vscode.commands.registerCommand('chorus.addEvidence', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('No Active Editor');
        return;
      }

      try {
        // prompt for PR reference
        const prRef = await vscode.window.showInputBox({
          prompt: 'Enter PR Reference (e.g., #123 or full URL)',
          placeHolder: '#123',
          validateInput: (value) => {
            return value.trim() === '' ? 'PR Reference is Required' : undefined;
          },
        });

        if (!prRef) {
          return;
        }

        // get clipboard content
        const clipboardText = await vscode.env.clipboard.readText();

        // try to parse as test JSON
        let evidenceData = null;
        try {
          evidenceData = JSON.parse(clipboardText);
        } catch {
          // not JSON, use raw text
        }

        const evidenceBlock = formatEvidenceBlock(evidenceData, clipboardText);

        // parse evidence data for database persistence
        const evidence = parseEvidenceData(prRef, evidenceData, clipboardText);

        // validate evidence
        const validation = validateEvidence(evidence);

        // save to database
        await db.saveEvidence(evidence);

        // insert evidence block
        await editor.edit((editBuilder) => {
          const position = editor.selection.active;
          editBuilder.insert(position, evidenceBlock);
        });

        // show success with validation warnings if any
        if (validation.warnings.length > 0) {
          const warningMsg = `Evidence Added\n\nWarnings:\n${validation.warnings.map((w) => `- ${w}`).join('\n')}`;
          vscode.window.showWarningMessage(warningMsg);
        } else {
          vscode.window.showInformationMessage('Chorus Evidence Block Added Successfully');
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to Add Evidence: ${error instanceof Error ? error.message : 'Unknown Error'}`
        );
      }
    });

    // register reindex command
    console.log('Registering chorus.reindexWorkspace command...');
    const reindexCommand = vscode.commands.registerCommand('chorus.reindexWorkspace', async () => {
      try {
        await incrementalIndexer.forceReindex();
        vscode.window.showInformationMessage('Chorus: Workspace Reindexed Successfully');
      } catch (error) {
        console.error('Failed to reindex workspace:', error);
        vscode.window.showErrorMessage(
          `Failed to Reindex Workspace: ${error instanceof Error ? error.message : 'Unknown Error'}`
        );
      }
    });

    // register show index status command
    console.log('Registering chorus.showIndexStatus command...');
    const showIndexStatusCommand = vscode.commands.registerCommand(
      'chorus.showIndexStatus',
      async () => {
        try {
          const lastCommit = await db.getLastIndexedCommit();
          const totalItems = await db.searchContext('');

          const message = `**Chorus Index Status**

**Total Items**: ${totalItems.length} entries indexed
**Last Indexed Commit**: ${lastCommit || 'None'}

**Actions**:
- Click "Reindex" below to force a complete reindex
- File changes are automatically detected and indexed`;

          const action = await vscode.window.showInformationMessage(message, 'Reindex', 'Close');

          if (action === 'Reindex') {
            await vscode.commands.executeCommand('chorus.reindexWorkspace');
          }
        } catch (error) {
          console.error('Failed to show index status:', error);
          vscode.window.showErrorMessage('Failed to Retrieve Index Status');
        }
      }
    );

    // register CodeLens provider
    console.log('Registering CodeLens provider...');
    const codeLensProvider = new RelatedContextProvider(db);
    const codeLensDisposable = vscode.languages.registerCodeLensProvider(
      { scheme: 'file', language: 'typescript' },
      codeLensProvider
    );

    // register tree view provider
    console.log('Registering context tree view...');
    const indexer = new Indexer(db);
    const treeProvider = new ContextTreeProvider(db, indexer, githubService);
    const treeView = vscode.window.createTreeView('chorus.contextView', {
      treeDataProvider: treeProvider,
      showCollapseAll: true,
    });

    // register hover provider
    console.log('Registering hover provider...');
    const hoverProvider = new ContextHoverProvider(indexer);
    const hoverDisposable = vscode.languages.registerHoverProvider(
      { scheme: 'file', pattern: '**/*' },
      hoverProvider
    );

    // register context peek command
    console.log('Registering chorus.showContextPeek command...');
    const contextPeekCommand = vscode.commands.registerCommand(
      'chorus.showContextPeek',
      async (_range: vscode.Range, items: ContextEntry[]) => {
        // create webview panel positioned beside editor
        const panel = vscode.window.createWebviewPanel(
          'chorusContextPeek',
          'Related Context',
          { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
          { enableScripts: true }
        );

        panel.webview.html = getContextPeekHtml(items);

        // handle messages from webview
        panel.webview.onDidReceiveMessage(async (message) => {
          if (message.command === 'openFile' && message.path) {
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            const fullPath = message.path.startsWith('/')
              ? message.path
              : `${workspacePath}/${message.path}`;
            const uri = vscode.Uri.file(fullPath);
            await vscode.window.showTextDocument(uri);
          } else if (message.command === 'viewCommit' && message.hash) {
            // open git log for commit
            vscode.window.showInformationMessage(`View Commit: ${message.hash}`);
          }
        });
      }
    );

    // register view context item command
    console.log('Registering chorus.viewContextItem command...');
    const viewContextItemCommand = vscode.commands.registerCommand(
      'chorus.viewContextItem',
      async (item: ContextEntry) => {
        if (item.type === 'doc') {
          // open document
          const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
          const fullPath = item.path.startsWith('/') ? item.path : `${workspacePath}/${item.path}`;
          const uri = vscode.Uri.file(fullPath);
          await vscode.window.showTextDocument(uri);
        } else if (item.type === 'commit') {
          // show commit info in panel
          ChorusPanel.createOrShow(context.extensionUri, db, githubService);
        }
      }
    );

    // register view pr ballots command
    console.log('Registering chorus.viewPRBallots command...');
    const viewPRBallotsCommand = vscode.commands.registerCommand(
      'chorus.viewPRBallots',
      async (prReference: string) => {
        const ballots = await db.getBallotsByPR(prReference);
        const phase = await db.getPRPhase(prReference);

        const message =
          `PR: ${prReference}\n` +
          `Phase: ${phase || 'not initialized'}\n` +
          `Ballots: ${ballots.length}\n\n` +
          ballots
            .map(
              (b) =>
                `${b.decision.toUpperCase()} (confidence: ${b.confidence})\n` +
                `Rationale: ${b.rationale}`
            )
            .join('\n\n');

        await vscode.window.showInformationMessage(message, { modal: true });
      }
    );

    // register quick submit ballot command
    console.log('Registering chorus.quickSubmitBallot command...');
    const quickSubmitBallotCommand = vscode.commands.registerCommand(
      'chorus.quickSubmitBallot',
      async () => {
        try {
          // step 1: select PR
          const prRef = await vscode.window.showInputBox({
            prompt: 'Enter PR Reference',
            placeHolder: '#123 or https://github.com/...',
          });

          if (!prRef) {
            return;
          }

          // check if ballot can be submitted
          const canSubmit = await db.canSubmitBallot(prRef);
          if (!canSubmit) {
            vscode.window.showErrorMessage('Cannot Submit Ballot: PR is Already in Revealed Phase');
            return;
          }

          // initialize blinded review if not already initialized
          const phase = await db.getPRPhase(prRef);
          if (phase === null) {
            await db.startBlindedReview(prRef, 3);
          }

          // step 2: select decision
          const decisionChoice = await vscode.window.showQuickPick(
            ['Approve', 'Neutral', 'Reject'],
            { placeHolder: 'What is Your Decision?' }
          );

          if (!decisionChoice) {
            return;
          }

          const decision = decisionChoice.toLowerCase() as 'approve' | 'neutral' | 'reject';

          // step 3: confidence slider (1-5)
          const confidenceChoice = await vscode.window.showQuickPick(
            ['1 - Low Confidence', '2', '3 - Medium Confidence', '4', '5 - High Confidence'],
            { placeHolder: 'How Confident Are You?' }
          );

          if (!confidenceChoice) {
            return;
          }

          const confidence = parseInt(confidenceChoice.charAt(0));

          // step 4: rationale
          const rationale = await vscode.window.showInputBox({
            prompt: 'Provide Evidence-Based Rationale',
            placeHolder: 'Tests pass, performance is good, security reviewed...',
          });

          if (!rationale) {
            return;
          }

          // get git config for author metadata
          const gitConfig = await getGitConfig();
          const authorMetadata = JSON.stringify({
            name: gitConfig.name || 'Unknown',
            email: gitConfig.email || 'unknown@example.com',
            timestamp: new Date().toISOString(),
          });

          // submit to database
          await db.addBallot({
            pr_reference: prRef,
            decision,
            confidence,
            rationale,
            author_metadata: authorMetadata,
            revealed: false,
          });

          vscode.window.showInformationMessage('Ballot Submitted Successfully!');

          // refresh tree view
          treeProvider.refresh();
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to Submit Ballot: ${error instanceof Error ? error.message : 'Unknown Error'}`
          );
        }
      }
    );

    // register tag pr outcome command
    console.log('Registering chorus.tagPROutcome command...');
    const tagPROutcomeCommand = vscode.commands.registerCommand('chorus.tagPROutcome', async () => {
      try {
        // step 1: get PR reference
        const prRef = await vscode.window.showInputBox({
          prompt: 'Enter PR Reference',
          placeHolder: '#123 or https://github.com/...',
        });

        if (!prRef) {
          return;
        }

        // step 2: select outcome type
        const outcomeChoice = await vscode.window.showQuickPick(
          [
            {
              label: 'Merged Clean',
              description: 'PR merged successfully with no issues',
              value: 'merged_clean',
            },
            {
              label: 'Bug Found',
              description: 'Issues discovered after merge requiring fixes',
              value: 'bug_found',
            },
            {
              label: 'Reverted',
              description: 'PR was rolled back due to problems',
              value: 'reverted',
            },
            {
              label: 'Follow-up Required',
              description: 'Additional work needed post-merge',
              value: 'followup_required',
            },
          ],
          { placeHolder: 'What Was the Outcome?' }
        );

        if (!outcomeChoice) {
          return;
        }

        const outcomeType = outcomeChoice.value as
          | 'merged_clean'
          | 'bug_found'
          | 'reverted'
          | 'followup_required';

        // step 3: get optional notes
        const notes = await vscode.window.showInputBox({
          prompt: 'Any Additional Notes? (Optional)',
          placeHolder: 'e.g., hotfix deployed on day 3, performance issue detected...',
        });

        // record outcome in database
        const detectionDetails = {
          source: 'manual',
          notes: notes || '',
          timestamp: new Date().toISOString(),
        };

        await db.recordOutcome(prRef, outcomeType, false, detectionDetails);

        vscode.window.showInformationMessage(`Outcome Tagged: ${outcomeChoice.label} for ${prRef}`);

        // refresh calibration data if panel is open
        if (ChorusPanel.currentPanel) {
          // panel will refresh on next view
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to Tag Outcome: ${error instanceof Error ? error.message : 'Unknown Error'}`
        );
      }
    });

    // register record decision scheme command
    console.log('Registering chorus.recordDecisionScheme command...');
    const recordDecisionSchemeCommand = vscode.commands.registerCommand(
      'chorus.recordDecisionScheme',
      async () => {
        // open panel and trigger modal
        vscode.commands.executeCommand('chorus.showPanel');
      }
    );

    // register open retrospective prompt command
    console.log('Registering chorus.openRetrospectivePrompt command...');
    const openRetrospectivePromptCommand = vscode.commands.registerCommand(
      'chorus.openRetrospectivePrompt',
      async () => {
        // open panel and trigger modal
        vscode.commands.executeCommand('chorus.showPanel');
      }
    );

    // register export retrospectives command
    console.log('Registering chorus.exportRetrospectives command...');
    const exportRetrospectivesCommand = vscode.commands.registerCommand(
      'chorus.exportRetrospectives',
      async () => {
        vscode.commands.executeCommand('chorus.showPanel');
      }
    );

    // register focus context view command
    console.log('Registering chorus.focusContextView command...');
    const focusContextViewCommand = vscode.commands.registerCommand(
      'chorus.focusContextView',
      async () => {
        // reveal the tree view by focusing on it
        await vscode.commands.executeCommand('chorus.contextView.focus');
      }
    );
    // register configure github token command
    console.log('Registering chorus.configureGitHubToken command...');
    const configureGitHubTokenCommand = vscode.commands.registerCommand(
      'chorus.configureGitHubToken',
      async () => {
        try {
          const action = await vscode.window.showInformationMessage(
            'Configure GitHub Token for Chorus\n\n' +
              'A GitHub personal access token enables:\n' +
              '- Higher API rate limits (5000 vs 60 requests/hour)\n' +
              '- Access to private repositories\n' +
              '- Indexing PR descriptions and issue comments\n\n' +
              'Required scopes: public_repo (or repo for private repos)\n\n' +
              'Token is stored securely in VS Code secret storage.',
            { modal: true },
            'Set Token',
            'Remove Token',
            'Create Token',
            'Cancel'
          );

          if (action === 'Create Token') {
            await vscode.env.openExternal(
              vscode.Uri.parse(
                'https://github.com/settings/tokens/new?scopes=public_repo&description=Chorus%20Extension'
              )
            );
            return;
          }

          if (action === 'Remove Token') {
            await githubService.setToken(undefined);
            vscode.window.showInformationMessage('GitHub Token Removed Successfully');
            return;
          }

          if (action === 'Set Token') {
            const token = await vscode.window.showInputBox({
              prompt: 'Enter GitHub Personal Access Token',
              placeHolder: 'ghp_...',
              password: true,
              validateInput: (value) => {
                if (!value || value.trim() === '') {
                  return 'Token Cannot Be Empty';
                }
                if (!value.startsWith('ghp_') && !value.startsWith('github_pat_')) {
                  return 'Token Should Start with ghp_ or github_pat_';
                }
                return undefined;
              },
            });

            if (token) {
              await githubService.setToken(token);
              vscode.window.showInformationMessage('GitHub Token Configured Successfully');

              // offer to reindex workspace to fetch github data
              const reindex = await vscode.window.showInformationMessage(
                'Reindex Workspace to Fetch GitHub Data?',
                'Reindex',
                'Later'
              );

              if (reindex === 'Reindex') {
                await vscode.commands.executeCommand('chorus.reindexWorkspace');
              }
            }
          }
        } catch (error) {
          console.error('Failed to configure GitHub token:', error);
          vscode.window.showErrorMessage(
            `Failed to Configure GitHub Token: ${error instanceof Error ? error.message : 'Unknown Error'}`
          );
        }
      }
    );

    // register show welcome command
    console.log('Registering chorus.showWelcome command...');
    const showWelcomeCommand = vscode.commands.registerCommand('chorus.showWelcome', () => {
      console.log('chorus.showWelcome command triggered');
      WelcomePanel.show(context.extensionUri);
    });

    // register show thriving checklist command
    console.log('Registering chorus.showThrivingChecklist command...');
    const showThrivingChecklistCommand = vscode.commands.registerCommand(
      'chorus.showThrivingChecklist',
      () => {
        ChorusPanel.createOrShow(context.extensionUri, db, githubService);
      }
    );

    console.log('Adding disposables to context...');
    context.subscriptions.push(
      panelCommand,
      addEvidenceCommand,
      reindexCommand,
      showIndexStatusCommand,
      codeLensDisposable,
      treeView,
      hoverDisposable,
      contextPeekCommand,
      viewContextItemCommand,
      viewPRBallotsCommand,
      quickSubmitBallotCommand,
      tagPROutcomeCommand,
      recordDecisionSchemeCommand,
      openRetrospectivePromptCommand,
      exportRetrospectivesCommand,
      focusContextViewCommand,
      configureGitHubTokenCommand,
      showWelcomeCommand,
      showThrivingChecklistCommand,
      chorusStatusBarItem,
      indexStatusBarItem,
      incrementalIndexer,
      db
    );

    // set context for conditional UI
    console.log('Setting chorus.enabled context...');
    await vscode.commands.executeCommand('setContext', 'chorus.enabled', true);

    // show welcome panel on first activation
    const hasSeenWelcome = context.globalState.get('chorus.hasSeenWelcome', false);
    if (!hasSeenWelcome) {
      WelcomePanel.show(context.extensionUri);
      await context.globalState.update('chorus.hasSeenWelcome', true);
    }

    console.log('✅ Chorus extension activated successfully');
  } catch (error) {
    console.error('Failed to activate Chorus extension:', error);
    vscode.window.showErrorMessage(
      `Failed to Activate Chorus Extension: ${error instanceof Error ? error.message : 'Unknown Error'}`
    );
    throw error;
  }
}

export function deactivate(): void {
  console.log('Deactivating Chorus extension...');
}

/**
 * Parses evidence data from clipboard content and structures it for database persistence.
 *
 * Automatically detects test results, coverage data, and benchmarks from JSON or raw text.
 * Sets reasonable defaults for missing fields to enable quick evidence capture.
 *
 * @param prRef - The PR reference
 * @param evidenceData - Parsed JSON data (if available)
 * @param rawText - Raw clipboard text
 * @returns Structured evidence entry ready for validation and persistence
 */
function parseEvidenceData(
  prRef: string,
  evidenceData: any,
  rawText: string
): Omit<EvidenceEntry, 'id' | 'timestamp'> {
  let testsStatus: EvidenceStatus = 'n/a';
  let testsDetails = '';
  let benchmarksStatus: EvidenceStatus = 'n/a';
  let benchmarksDetails = '';

  // detect test results from JSON data
  if (evidenceData) {
    if (
      evidenceData.testResults ||
      evidenceData.tests ||
      evidenceData.numPassedTests !== undefined
    ) {
      testsStatus = 'complete';
      testsDetails = JSON.stringify(evidenceData, null, 2);
    }

    if (evidenceData.benchmarks || evidenceData.performance) {
      benchmarksStatus = 'complete';
      benchmarksDetails = JSON.stringify(evidenceData, null, 2);
    }
  }

  // fallback to raw text if no structured data
  if (testsStatus === 'n/a' && benchmarksStatus === 'n/a' && rawText.trim()) {
    // check for benchmark data first (more specific pattern)
    if (rawText.match(/benchmark|performance|latency|throughput|ops\/sec/i)) {
      benchmarksStatus = 'complete';
      benchmarksDetails = rawText.trim();
    }
    // otherwise check if raw text looks like test output
    else if (rawText.match(/test|pass|fail|coverage/i)) {
      testsStatus = 'complete';
      testsDetails = rawText.trim();
    }
  }

  return {
    pr_reference: prRef,
    tests_status: testsStatus,
    tests_details: testsDetails,
    benchmarks_status: benchmarksStatus,
    benchmarks_details: benchmarksDetails,
    spec_status: 'n/a',
    spec_references: '',
    risk_level: 'low',
    identified_risks: '',
    rollback_plan: '',
  };
}

function formatEvidenceBlock(evidenceData: any, rawText: string): string {
  const timestamp = new Date().toISOString();

  // check for test data patterns
  let testsSection = '';
  let benchmarksSection = '';

  if (evidenceData) {
    // handle common test frameworks
    if (evidenceData.testResults || evidenceData.tests) {
      testsSection = formatTestResults(evidenceData);
    } else if (evidenceData.coverage) {
      testsSection = formatCoverageData(evidenceData);
    } else if (evidenceData.numPassedTests !== undefined) {
      testsSection = formatJestResults(evidenceData);
    }

    // handle benchmark data
    if (evidenceData.benchmarks || evidenceData.performance) {
      benchmarksSection = formatBenchmarkData(evidenceData);
    }
  }

  // fallback to raw text if no structured data
  if (!testsSection && rawText.trim()) {
    testsSection = `\`\`\`\n${rawText.trim()}\n\`\`\``;
  }

  return `
<details>
<summary><strong>🎭 Chorus Evidence</strong> - ${timestamp}</summary>

### Tests
${testsSection || '**Status**: [ ] Complete [ ] In Progress [ ] N/A\n\n**Details**: _Add test information here_'}

### Benchmarks
${benchmarksSection || '**Status**: [ ] Complete [ ] In Progress [ ] N/A\n\n**Details**: _Add performance metrics or mark N/A_'}

### Specification/ADR References
**Status**: [ ] Complete [ ] In Progress [ ] N/A

**References**: _Add links to specs, ADRs, or design documents_

### Risk Assessment & Rollback Plan
**Risk Level**: [ ] Low [ ] Medium [ ] High

**Identified Risks**: _List potential risks_

**Rollback Plan**: _Describe rollback strategy_

</details>
`;
}

function formatTestResults(data: any): string {
  if (data.testResults) {
    const passed = data.testResults.filter((t: any) => t.status === 'passed').length;
    const failed = data.testResults.filter((t: any) => t.status === 'failed').length;
    return `**Status**: ✅ Complete\n\n**Results**: ${passed} passed, ${failed} failed\n**Coverage**: ${data.coverage?.pct || 'N/A'}%`;
  }
  return `**Status**: ✅ Complete\n\n**Details**: Test results processed`;
}

function formatCoverageData(data: any): string {
  const { lines, functions, branches, statements } = data.coverage.total || data.coverage;
  return `**Status**: ✅ Complete

**Coverage Report**:
- Lines: ${lines?.pct || 'N/A'}%
- Functions: ${functions?.pct || 'N/A'}%
- Branches: ${branches?.pct || 'N/A'}%
- Statements: ${statements?.pct || 'N/A'}%`;
}

function formatJestResults(data: any): string {
  return `**Status**: ${data.success ? '✅ Complete' : '❌ Failed'}

**Jest Results**:
- Passed: ${data.numPassedTests || 0}
- Failed: ${data.numFailedTests || 0}
- Skipped: ${data.numPendingTests || 0}
- Duration: ${data.testExecTime || 'N/A'}ms`;
}

function formatBenchmarkData(data: any): string {
  if (data.benchmarks) {
    return `**Status**: ✅ Complete\n\n**Benchmark Results**: ${data.benchmarks.length} tests completed`;
  }
  return `**Status**: ✅ Complete\n\n**Performance**: Metrics captured`;
}

// helper function to get git config
async function getGitConfig(): Promise<{ name?: string; email?: string }> {
  try {
    const { spawn } = await import('child_process');

    const getName = (): Promise<string> =>
      new Promise((resolve) => {
        const proc = spawn('git', ['config', 'user.name']);
        let output = '';
        proc.stdout.on('data', (data) => (output += data.toString()));
        proc.on('close', () => resolve(output.trim()));
      });

    const getEmail = (): Promise<string> =>
      new Promise((resolve) => {
        const proc = spawn('git', ['config', 'user.email']);
        let output = '';
        proc.stdout.on('data', (data) => (output += data.toString()));
        proc.on('close', () => resolve(output.trim()));
      });

    const [name, email] = await Promise.all([getName(), getEmail()]);

    return { name, email };
  } catch (error) {
    console.error('Failed to get git config:', error);
    return {};
  }
}

// helper function to generate context peek html
function getContextPeekHtml(items: ContextEntry[]): string {
  const itemsHtml = items
    .slice(0, 10)
    .map((item) => {
      if (item.type === 'commit') {
        const hash = item.metadata['hash']?.substring(0, 7) || 'unknown';
        const author = item.metadata['author'] || 'Unknown';
        const date = item.metadata['date']
          ? new Date(item.metadata['date'] as string).toLocaleDateString()
          : 'Unknown';

        return `
        <div class="context-item" data-type="commit">
          <div class="icon">📝</div>
          <div class="content">
            <div class="title">${escapeHtml(item.title)}</div>
            <div class="meta">${hash} - ${author} - ${date}</div>
            <button class="action-btn" onclick="viewCommit('${item.metadata['hash'] as string}')">View Commit</button>
          </div>
        </div>
      `;
      } else if (item.type === 'doc') {
        const preview = item.content.substring(0, 150).replace(/\n/g, ' ');

        return `
        <div class="context-item" data-type="doc">
          <div class="icon">📖</div>
          <div class="content">
            <div class="title">${escapeHtml(item.path)}</div>
            <div class="meta">${escapeHtml(preview)}...</div>
            <button class="action-btn" onclick="openFile('${escapeHtml(item.path)}')">Open File</button>
          </div>
        </div>
      `;
      }

      return '';
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Related Context</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
    }

    h3 {
      margin-top: 0;
      color: var(--vscode-textLink-foreground);
    }

    .context-item {
      display: flex;
      gap: 15px;
      padding: 15px;
      margin-bottom: 15px;
      background-color: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 6px;
      border-left: 3px solid var(--vscode-textLink-foreground);
    }

    .context-item .icon {
      font-size: 24px;
      flex-shrink: 0;
    }

    .context-item .content {
      flex-grow: 1;
    }

    .context-item .title {
      font-weight: bold;
      margin-bottom: 5px;
    }

    .context-item .meta {
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 10px;
    }

    .action-btn {
      padding: 5px 12px;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
    }

    .action-btn:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <h3>Related Context</h3>
  ${itemsHtml}

  <script>
    const vscode = acquireVsCodeApi();

    function openFile(path) {
      vscode.postMessage({ command: 'openFile', path: path });
    }

    function viewCommit(hash) {
      vscode.postMessage({ command: 'viewCommit', hash: hash });
    }
  </script>
</body>
</html>`;
}

// helper function to escape html
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
