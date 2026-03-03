# Chorus: Evidence-first Code Review

**Stop groupthink before it starts.** Chorus brings structured, independent judgment to code reviews so your team catches what consensus-driven reviews miss.

## Why Chorus?

Standard code reviews have a hidden problem: the first comment anchors everyone. Junior devs defer to seniors. Teams converge too fast. Unique insights stay silent.

Chorus fixes this with **blinded ballots** -- reviewers submit independent decisions *before* seeing anyone else's vote. Then the team discusses with full context, not conformity pressure.

## How It Works

Chorus adds five layers to your review workflow:

1. **Context** -- Automatically surfaces related commits, PRs, and docs for the code you're reviewing. No more guessing why something was written a certain way.

2. **Participation** -- Elaboration prompts encourage deeper thinking: "Have you considered alternative approaches?" and "What's the main risk?" These nudges surface minority opinions.

3. **Evidence** -- Structured templates for test results, benchmarks, and specs. Paste test output and Chorus parses pass/fail counts automatically (Jest, Vitest, Pytest).

4. **Calibration** -- Track your confidence (1--5) against actual outcomes. Over time, see your Brier score and learn where you're overconfident or underconfident.

5. **Reflection** -- Post-merge pattern detection flags systematic issues: overconfidence trends, low variation in decision schemes, and decisions that need follow-up.

## Review Workflow

1. Open the Chorus panel (`Ctrl+Shift+C` / `Cmd+Shift+C`)
2. Enter a PR number, URL, or branch name
3. **Blinded phase**: each reviewer submits a ballot independently (Approve / Neutral / Reject + confidence level + rationale)
4. **Reveal phase**: see all votes, discuss with full context
5. Choose a **decision scheme** to aggregate votes:
   - **Consensus** -- everyone must agree (breaking changes)
   - **Majority** -- >50% approval (standard features)
   - **Truth-wins** -- any approval merges (bug fixes)
   - **Expert-veto** -- domain experts can block (security/performance)
6. After merge, record the outcome to build your calibration history

## Commands

| Command | Shortcut | Description |
| --- | --- | --- |
| `Chorus: Show Chorus Panel` | `Ctrl+Shift+C` | Open the main Chorus panel |
| `Chorus: Add Chorus Evidence Block` | `Ctrl+Shift+E` | Parse and add structured evidence |
| `Chorus: Submit Ballot (Quick)` | `Ctrl+Shift+B` | Submit an independent review ballot |
| `Chorus: Focus Context View` | `Ctrl+Shift+K` | Focus the context discovery sidebar |
| `Chorus: Reindex Workspace` | -- | Rebuild the local context index |
| `Chorus: Show Index Status` | -- | View indexing progress |
| `Chorus: View PR Ballots` | -- | See ballots for the current PR |
| `Chorus: Configure GitHub Token` | -- | Set up GitHub API access |
| `Chorus: Show Welcome Page` | -- | Open the getting-started walkthrough |
| `Chorus: Show Thriving Checklist` | -- | Open the team thriving checklist |
| `Chorus: Show Context Peek` | -- | Peek at context for current selection |
| `Chorus: View Context Item` | -- | Open a specific context entry |

## Configuration

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `chorus.autoPostBallots` | `boolean` | `false` | Automatically post ballot summaries to GitHub PRs after the reveal phase |

## Features at a Glance

- **Blinded ballots** -- independent votes before group discussion
- **CodeLens annotations** -- see related context inline ("Related context (3)")
- **Context sidebar** -- browse related commits, PRs, and docs in a dedicated tree view
- **Evidence parsing** -- paste test output, get structured results
- **Calibration dashboard** -- Brier scores and accuracy tracking over time
- **Reflection insights** -- automatic detection of overconfidence, groupthink, and low-variation patterns
- **Decision schemes** -- consensus, majority, truth-wins, or expert-veto
- **Local-first** -- all data stored locally via SQLite; no external services required
- **GitHub integration** (optional) -- pull PR metadata and post ballot summaries
- **Privacy-preserving** -- ballots use anonymous IDs until the reveal phase

## Requirements

- VS Code 1.74+ or Positron
- Node.js 18+
- A git repository open in the workspace

GitHub integration is optional. Core features work entirely offline with local git history.

## License

AGPL-3.0 -- see [LICENSE](https://github.com/user/chorus/blob/main/LICENSE) for details.
