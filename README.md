# Chorus

> **A VS Code extension that prevents groupthink in code reviews**

[![CI](https://github.com/user/chorus/actions/workflows/ci.yml/badge.svg)](https://github.com/user/chorus/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/badge/coverage-%E2%89%A580%25-brightgreen)]()

Chorus is a code review tool grounded in social psychology research. It addresses systematic biases in team decision-making by separating independent judgment from group discussion, helping teams make better technical decisions while reducing conformity pressure and overconfidence.

## The Problem

Standard code review workflows suffer from well-documented psychological issues:

- **Conformity pressure**: Junior developers defer to senior opinions without voicing concerns
- **Groupthink**: Teams converge on consensus too quickly, missing critical issues
- **Hidden profiles**: Unique knowledge held by individual reviewers never surfaces
- **Overconfidence bias**: Reviewers don't calibrate their certainty against actual outcomes
- **Authority bias**: First comments from high-status reviewers anchor the discussion

These are common outcomes of how human cognition works in group settings.

## The Solution

Chorus implements a **5-layer decision architecture** based on social judgment theory:

### 1. Context Layer

Automatically surfaces relevant code history, related PRs, and documentation using local git indexing and BM25 relevance scoring. No more "why was this written this way?" questions because the answer is already in the panel.

### 2. Participation Layer

**Elaboration nudges** prompt reviewers to articulate their reasoning before voting:

- "Have you considered alternative approaches?"
- "What's the main risk you're concerned about?"
- "Any dissenting views worth noting?"

These prompts combat shallow reviews and surface minority opinions that might otherwise be suppressed.

### 3. Evidence Layer

Structured templates require concrete evidence (test results, benchmarks, specs) rather than opinions. Smart parsing detects test frameworks (Jest, Vitest, Pytest) and extracts pass/fail counts automatically.

### 4. Calibration Layer

Reviewers assign confidence levels (1-5) to their decisions. The system tracks actual outcomes and computes Brier scores, showing you when you're overconfident or underconfident. Over time, this trains better judgment calibration.

### 5. Reflection Layer

Post-merge retrospectives and pattern detection identify systematic issues:

- **Overconfidence patterns**: High confidence + wrong outcome
- **Lack of variation**: Team always uses same decision scheme
- **Low-confidence decisions**: Uncertainty markers that warrant follow-up

## Why This Works

Chorus doesn't try to eliminate human bias; rather, it redesigns the decision-making _process_ to work with how people actually think:

1. **Blinded ballots**: Reviewers submit independent judgments before seeing others' votes, preventing anchoring and conformity
2. **Reveal phase**: After collecting independent input, the team transitions to open discussion with full context
3. **Decision schemes**: Teams explicitly choose aggregation rules (consensus, majority, truth-wins, expert-veto) based on PR context
4. **Outcome tracking**: Calibration metrics close the feedback loop, turning reviews into learning opportunities

This is the same approach used in intelligence analysis, medical diagnosis, and other high-stakes decision domains.

## Installation

### From VS Code Marketplace

```bash
code --install-extension chorus.chorus-extension
```

### From VSIX

```bash
code --install-extension chorus-extension-0.1.0.vsix
```

### From Source

```bash
git clone https://github.com/user/chorus.git
cd chorus
npm ci
cd packages/chorus-extension
npm ci
npm run build
code --install-extension .
```

## Usage

### Basic Workflow

1. **Open Chorus Panel**: `Ctrl+Shift+P` → `Chorus: Show Panel` (or click status bar)

2. **Enter PR reference**: Type PR number, URL, or branch name

3. **Start Blinded Review**: Chorus enters "blinded phase". Reviewers can now submit ballots independently

4. **Submit Ballots**: Each reviewer provides:
   - **Decision**: Approve / Neutral / Reject
   - **Confidence**: 1-5 (how certain are you?)
   - **Rationale**: Evidence-based reasoning
   - **Nudge responses**: Required for low-confidence votes

5. **Reveal Results**: When ready (e.g., 3+ ballots), click "Reveal Results" to see aggregated votes and transition to discussion

6. **Choose Decision Scheme**: Select how to aggregate votes:
   - **Consensus**: Everyone must agree (use for breaking changes)
   - **Majority**: >50% approval (use for standard features)
   - **Truth-wins**: Any approval wins (use for bug fixes)
   - **Expert-veto**: Domain experts have veto power (use for security/performance)

7. **Track Outcome**: After merge, mark whether the decision was correct. This feeds your calibration dashboard.

### Context Discovery

The **Context** tab shows related commits, PRs, and docs for the current changes:

```typescript
// In your editor, changed lines show CodeLens annotations:
export function calculateTotal(items: Item[]) {
  // ← Related context (3)
  return items.reduce((sum, item) => sum + item.price, 0);
}
```

Click the annotation to see:

- Commits that previously modified this function
- PRs that discussed similar changes
- Documentation mentioning this code path

### Evidence Blocks

The **Evidence** tab generates structured evidence for PR descriptions:

```markdown
## Evidence

### Tests

✅ 47 passed, 0 failed (unit tests)
✅ 12 passed, 0 failed (integration tests)

### Benchmarks

| Operation | Before | After | Change |
| --------- | ------ | ----- | ------ |
| parse()   | 2.3ms  | 1.8ms | -21%   |

### Specs

Implements RFC-2024-03 (Async Validation)
Satisfies requirements: REQ-001, REQ-003, REQ-007

### Risk Assessment

- **Performance**: Low (benchmarked, no regressions)
- **Breaking**: None (backward compatible)
- **Security**: Medium (new input validation, needs audit)
```

Paste test output with `Ctrl+Shift+V` and Chorus parses it automatically.

### Calibration Dashboard

The **Calibration** tab shows your decision accuracy over time:

- **Brier Score**: How well-calibrated your confidence is (lower = better)
- **Calibration Curve**: Visual comparison of confidence vs. actual accuracy
- **Overconfidence Rate**: How often you're highly confident but wrong
- **High-Confidence Insights**: Specific decisions to review

Use this to identify when you're overconfident (common in your domain) vs. underconfident (common in unfamiliar code).

### Reflection & Patterns

The **Reflection** tab surfaces systematic issues:

- **Overconfidence warning**: "67% of your high-confidence rejections were wrong: Consider waiting for more evidence"
- **Lack of variation**: "85% of decisions use 'consensus' scheme: Consider majority voting for low-risk PRs"
- **Low-confidence patterns**: "5 recent PRs had avg confidence <2.5: Schedule retrospective"

These insights help teams learn and adapt their process over time.

## Commands

| Command                       | Shortcut       | Description                       |
| ----------------------------- | -------------- | --------------------------------- |
| `Chorus: Show Panel`          | `Ctrl+Shift+C` | Open the main Chorus panel        |
| `Chorus: Add Evidence Block`  | `Ctrl+Shift+V` | Parse clipboard test results      |
| `Chorus: Submit Ballot`       | -              | Submit independent review ballot  |
| `Chorus: Reveal Results`      | -              | End blinded phase, show all votes |
| `Chorus: Start Retrospective` | -              | Begin post-merge reflection       |

## Configuration

```jsonc
{
  // Show "Related context (n)" annotations in editor
  "chorus.enableCodeLens": true,

  // Minimum ballots required before reveal
  "chorus.minBallotsForReveal": 3,

  // Auto-index git history on startup
  "chorus.autoIndex": true,

  // Enable elaboration nudges for low-confidence votes
  "chorus.enableNudges": true,
}
```

## Architecture

```
packages/chorus-extension/
├── src/
│   ├── extension.ts              # Entry point, command registration
│   ├── panel/
│   │   └── ChorusPanel.ts        # Main webview UI (5 tabs)
│   ├── services/
│   │   ├── GitService.ts         # Git operations with security validation
│   │   ├── Indexer.ts            # BM25 relevance scoring
│   │   ├── ReflectionService.ts  # Pattern detection
│   │   └── GitHubService.ts      # GitHub API integration
│   ├── storage/
│   │   └── LocalDB.ts            # SQLite local storage
│   └── utils/
│       ├── calibration.ts        # Brier scores, calibration curves
│       └── gitSecurity.ts        # Input validation for git commands
└── media/
    ├── panel.js                  # Frontend interactions
    └── panel.css                 # Modern UI styled for VS Code
```

**Key technical decisions:**

- **Local-first**: SQLite database, no network calls (except opt-in GitHub integration)
- **Privacy-preserving**: Ballots stored with anonymous IDs until reveal
- **Security**: All git command inputs validated against injection attacks
- **TypeScript strict mode**: Full type safety throughout
- **404 tests, >80% coverage**: Comprehensive test suite with Vitest

## Research Foundation

Chorus implements techniques from:

- **Hidden Profile Paradigm** (Stasser & Titus, 1985): Blinded ballots surface unique information
- **Social Judgment Schemes** (Davis, 1973): Explicit aggregation rules based on task type
- **Calibration Training** (Lichtenstein & Fischhoff, 1980): Confidence tracking improves judgment
- **Elaboration Likelihood Model** (Petty & Cacioppo, 1986): Nudges increase thoughtful processing

## FAQ

**Q: Why not just use GitHub's review features?**
A: GitHub reviews are synchronous and public, which means the first comment anchors everyone else. Chorus separates independent judgment (ballots) from discussion (reveal phase).

**Q: Isn't this overkill for small PRs?**
A: Use decision schemes strategically. Small bug fixes can use "truth-wins" (any approval merges). Reserve "consensus" for high-risk changes.

**Q: What if reviewers ignore the process?**
A: Chorus is a tool, not a policy. Teams need to commit to independent review before discussion. The calibration dashboard provides feedback on whether or not this is working.

**Q: Does this slow down reviews?**
A: Initial overhead (~2 min per ballot) is offset by fewer back-and-forth rounds and post-merge fixes. Teams are expected to experience roughly 30% reduction in rework after adoption.

**Q: Can I use this without GitHub?**
A: Yes, the GitHub integration is optional. Core features work with local git repos as well as self-hosted ones.

## Known Limitations

- Large repos (>100k commits) may have slow initial indexing
- Context discovery limited to same repository (no cross-repo search yet)
- Calibration requires 20+ tracked outcomes for statistical significance
- Windows path handling has edge cases in file indexing

## License

**AGPL‑3.0 License**: See [LICENSE](LICENSE) for details.

**_Making better technical decisions through better decision-making processes._**
