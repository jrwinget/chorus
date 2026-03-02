import { spawn } from 'child_process';
import {
  validateOptionalISODate,
  sanitizePRReference,
  validateISODate,
} from '../utils/gitSecurity';

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  files: string[];
}

export async function simpleGitLog(
  workspacePath: string,
  limit: number = 50
): Promise<GitLogEntry[]> {
  return new Promise((resolve, reject) => {
    const gitProcess = spawn(
      'git',
      [
        'log',
        '--oneline',
        '--pretty=format:%H|%an|%ad|%s',
        '--date=iso',
        '--name-only',
        '-' + limit.toString(),
      ],
      {
        cwd: workspacePath,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';

    gitProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    gitProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    gitProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('Git command failed: ' + stderr));
        return;
      }

      try {
        const entries = parseGitLog(stdout);
        resolve(entries);
      } catch (error) {
        reject(error);
      }
    });

    gitProcess.on('error', (error) => {
      reject(new Error('Failed to spawn git process: ' + error.message));
    });
  });
}

function parseGitLog(output: string): GitLogEntry[] {
  const entries: GitLogEntry[] = [];
  const lines = output.split('\n').filter((line) => line.trim().length > 0);

  let currentEntry: Partial<GitLogEntry> | null = null;

  for (const line of lines) {
    if (line.includes('|')) {
      // this is a commit header line
      if (currentEntry) {
        // finalize the previous entry
        entries.push(currentEntry as GitLogEntry);
      }

      const parts = line.split('|');
      if (parts.length >= 4) {
        currentEntry = {
          hash: parts[0],
          author: parts[1],
          date: parts[2],
          subject: parts[3],
          body: '',
          files: [],
        };
      }
    } else if (currentEntry) {
      // this is a file name
      if (line.trim() && !line.startsWith(' ')) {
        currentEntry.files = currentEntry.files || [];
        currentEntry.files.push(line.trim());
      }
    }
  }

  // don't forget the last entry
  if (currentEntry) {
    entries.push(currentEntry as GitLogEntry);
  }

  return entries;
}

export async function getCurrentBranch(workspacePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const gitProcess = spawn('git', ['branch', '--show-current'], {
      cwd: workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    gitProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    gitProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    gitProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('Git command failed: ' + stderr));
        return;
      }

      resolve(stdout.trim());
    });

    gitProcess.on('error', (error) => {
      reject(new Error('Failed to spawn git process: ' + error.message));
    });
  });
}

/**
 * Detection result for PR outcomes
 */
export interface OutcomeDetection {
  commits: string[]; // commit hashes that match the pattern
  keywords: string[]; // keywords found in commits
  confidence: number; // 0-1 confidence score based on pattern strength
  firstDetectedDate?: string | undefined; // date of first matching commit
}

/**
 * Detects revert commits for a PR.
 *
 * Searches git log for commits containing "revert" or "rollback" keywords
 * that reference the PR number. Indicates the PR had issues and was rolled back.
 *
 * @param workspacePath - Path to git repository
 * @param prId - PR identifier (e.g., "#123" or "owner/repo#123")
 * @param sinceDate - Optional date to search from (ISO format)
 * @returns Promise resolving to detection result or null if not found
 */
export async function detectRevertCommits(
  workspacePath: string,
  prId: string,
  sinceDate?: string
): Promise<OutcomeDetection | null> {
  return new Promise((resolve, reject) => {
    // Validate and sanitize inputs
    // Even though spawn with array args is safe from shell injection,
    // we validate to ensure data integrity and catch malformed inputs early
    try {
      validateOptionalISODate(sinceDate, 'sinceDate');
    } catch (error) {
      reject(error);
      return;
    }

    // extract pr number from reference
    let prNumber: string;
    try {
      prNumber = sanitizePRReference(prId);
    } catch (error) {
      resolve(null); // Invalid PR reference, no results
      return;
    }

    // build git log command with date filter if provided
    const args = [
      'log',
      '--oneline',
      '--pretty=format:%H|%ad|%s',
      '--date=iso',
      '--all',
      '--grep=revert',
      '--grep=rollback',
      '--regexp-ignore-case',
      '-i',
    ];

    if (sinceDate) {
      args.push(`--since=${sinceDate}`);
    }

    const gitProcess = spawn('git', args, {
      cwd: workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    gitProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    gitProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    gitProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('Git command failed: ' + stderr));
        return;
      }

      // parse commits and check if they reference the PR
      const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
      const matchingCommits: string[] = [];
      const keywords: string[] = [];
      let firstDate: string | undefined;

      for (const line of lines) {
        const parts = line.split('|');
        if (parts.length >= 3) {
          const hash = parts[0];
          const date = parts[1];
          const subject = parts[2];

          // check if subject references the PR number
          if (subject.includes(`#${prNumber}`) || subject.includes(`PR ${prNumber}`)) {
            matchingCommits.push(hash);
            if (!firstDate) {
              firstDate = date;
            }

            // extract keywords
            if (/revert/i.test(subject)) {
              keywords.push('revert');
            }
            if (/rollback/i.test(subject)) {
              keywords.push('rollback');
            }
          }
        }
      }

      if (matchingCommits.length === 0) {
        resolve(null);
        return;
      }

      // calculate confidence based on keyword strength
      const hasRevert = keywords.includes('revert');
      const hasRollback = keywords.includes('rollback');
      const confidence = hasRevert || hasRollback ? 0.9 : 0.6;

      resolve({
        commits: matchingCommits,
        keywords: Array.from(new Set(keywords)),
        confidence,
        firstDetectedDate: firstDate,
      });
    });

    gitProcess.on('error', (error) => {
      reject(new Error('Failed to spawn git process: ' + error.message));
    });
  });
}

/**
 * Detects bug fix commits related to a PR.
 *
 * Searches for commits with "fix", "bug", "hotfix" keywords within a time window
 * after the PR was merged. Indicates the PR had issues that required fixes.
 *
 * @param workspacePath - Path to git repository
 * @param prId - PR identifier
 * @param mergeDate - Date when PR was merged (ISO format)
 * @param daysAfter - Number of days to search after merge (default: 7)
 * @returns Promise resolving to detection result or null if not found
 */
export async function detectBugFixCommits(
  workspacePath: string,
  prId: string,
  mergeDate: string,
  daysAfter: number = 7
): Promise<OutcomeDetection | null> {
  return new Promise((resolve, reject) => {
    // Validate and sanitize inputs
    let validatedMergeDate: string;
    let prNumber: string;

    try {
      validatedMergeDate = validateISODate(mergeDate, 'mergeDate');
      prNumber = sanitizePRReference(prId);
    } catch (error) {
      reject(error);
      return;
    }

    // calculate date range
    const mergeDateTime = new Date(validatedMergeDate);
    const endDate = new Date(mergeDateTime.getTime() + daysAfter * 24 * 60 * 60 * 1000);

    const args = [
      'log',
      '--oneline',
      '--pretty=format:%H|%ad|%s',
      '--date=iso',
      '--all',
      '--grep=fix',
      '--grep=bug',
      '--grep=hotfix',
      '--regexp-ignore-case',
      '-i',
      `--since=${validatedMergeDate}`,
      `--until=${endDate.toISOString()}`,
    ];

    const gitProcess = spawn('git', args, {
      cwd: workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    gitProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    gitProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    gitProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('Git command failed: ' + stderr));
        return;
      }

      const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
      const matchingCommits: string[] = [];
      const keywords: string[] = [];
      let firstDate: string | undefined;

      for (const line of lines) {
        const parts = line.split('|');
        if (parts.length >= 3) {
          const hash = parts[0];
          const date = parts[1];
          const subject = parts[2];

          // check if subject references the PR or related keywords
          const refersToFix = /fix/i.test(subject);
          const refersToBug = /bug/i.test(subject);
          const refersToHotfix = /hotfix/i.test(subject);
          const refersToPR = subject.includes(`#${prNumber}`) || subject.includes(`PR ${prNumber}`);

          if (refersToPR || refersToFix || refersToBug || refersToHotfix) {
            matchingCommits.push(hash);
            if (!firstDate) {
              firstDate = date;
            }

            if (refersToFix) {
              keywords.push('fix');
            }
            if (refersToBug) {
              keywords.push('bug');
            }
            if (refersToHotfix) {
              keywords.push('hotfix');
            }
          }
        }
      }

      if (matchingCommits.length === 0) {
        resolve(null);
        return;
      }

      // calculate confidence based on keyword strength and PR reference
      const hasHotfix = keywords.includes('hotfix');
      const hasBug = keywords.includes('bug');
      const hasFix = keywords.includes('fix');
      let confidence = 0.5; // base confidence

      if (hasHotfix) {
        confidence = 0.9;
      } else if (hasBug) {
        confidence = 0.8;
      } else if (hasFix) {
        confidence = 0.6;
      }

      resolve({
        commits: matchingCommits,
        keywords: Array.from(new Set(keywords)),
        confidence,
        firstDetectedDate: firstDate,
      });
    });

    gitProcess.on('error', (error) => {
      reject(new Error('Failed to spawn git process: ' + error.message));
    });
  });
}

/**
 * Detects if a PR merged cleanly without issues.
 *
 * Checks for absence of revert/fix commits within a time window after merge.
 * A clean merge indicates the PR was successful and didn't require fixes.
 *
 * @param workspacePath - Path to git repository
 * @param prId - PR identifier
 * @param mergeDate - Date when PR was merged (ISO format)
 * @param daysAfter - Number of days to monitor (default: 14)
 * @returns Promise resolving to detection result or null if issues found
 */
export async function detectCleanMerge(
  workspacePath: string,
  prId: string,
  mergeDate: string,
  daysAfter: number = 14
): Promise<OutcomeDetection | null> {
  // check for reverts
  const revertDetection = await detectRevertCommits(workspacePath, prId, mergeDate);
  if (revertDetection) {
    return null; // reverts found, not clean
  }

  // check for bug fixes
  const bugFixDetection = await detectBugFixCommits(workspacePath, prId, mergeDate, daysAfter);
  if (bugFixDetection) {
    return null; // bug fixes found, not clean
  }

  // no issues found within the time window
  return {
    commits: [],
    keywords: ['clean', 'stable'],
    confidence: 0.7, // moderate confidence - absence of evidence isn't conclusive
    firstDetectedDate: mergeDate,
  };
}

/**
 * Extracts PR number from branch name if it follows common naming conventions.
 *
 * Supports patterns like:
 * - feature/123-description
 * - bugfix/PR-456
 * - hotfix/gh-789
 * - PR123
 * - pr-123
 *
 * @param branchName - Current git branch name
 * @returns PR number if detected, null otherwise
 */
export function extractPRNumberFromBranch(branchName: string): string | null {
  if (!branchName) {
    return null;
  }

  // pattern 1: feature/123-description or bugfix/PR-123
  const pattern1 = /(?:feature|bugfix|hotfix|fix)\/(?:PR-?)?(\d+)/i;
  const match1 = branchName.match(pattern1);
  if (match1) {
    return match1[1];
  }

  // pattern 2: PR123 or pr-123 at start
  const pattern2 = /^(?:PR|pr)-?(\d+)/;
  const match2 = branchName.match(pattern2);
  if (match2) {
    return match2[1];
  }

  // pattern 3: gh-123 or GH-123
  const pattern3 = /(?:gh|GH)-(\d+)/;
  const match3 = branchName.match(pattern3);
  if (match3) {
    return match3[1];
  }

  // pattern 4: just numbers after slash
  const pattern4 = /\/(\d{1,5})(?:-|$)/;
  const match4 = branchName.match(pattern4);
  if (match4) {
    return match4[1];
  }

  return null;
}
