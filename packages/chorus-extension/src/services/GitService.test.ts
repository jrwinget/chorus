import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  simpleGitLog,
  getCurrentBranch,
  GitLogEntry,
  detectRevertCommits,
  detectBugFixCommits,
  detectCleanMerge,
  extractPRNumberFromBranch,
} from './GitService';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

// mock child_process
vi.mock('child_process');

describe('GitService', () => {
  let mockSpawn: any;
  let mockProcess: any;

  beforeEach(() => {
    mockProcess = new EventEmitter();
    mockProcess.stdout = new EventEmitter();
    mockProcess.stderr = new EventEmitter();

    mockSpawn = vi.mocked(spawn);
    mockSpawn.mockReturnValue(mockProcess);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('simpleGitLog', () => {
    it('should parse git log output correctly', async () => {
      const mockOutput = `abc123|John Doe|2023-01-01 12:00:00|feat: add authentication
src/auth.ts
src/types.ts

def456|Jane Smith|2023-01-02 15:30:00|fix: resolve login bug
src/login.ts`;

      // create promise and resolve it after setting up the mock
      const promise = simpleGitLog('/test/workspace', 10);

      // simulate successful git command
      setTimeout(() => {
        mockProcess.stdout.emit('data', mockOutput);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;

      expect(result).toHaveLength(2);

      expect(result[0]).toEqual({
        hash: 'abc123',
        author: 'John Doe',
        date: '2023-01-01 12:00:00',
        subject: 'feat: add authentication',
        body: '',
        files: ['src/auth.ts', 'src/types.ts'],
      });

      expect(result[1]).toEqual({
        hash: 'def456',
        author: 'Jane Smith',
        date: '2023-01-02 15:30:00',
        subject: 'fix: resolve login bug',
        body: '',
        files: ['src/login.ts'],
      });
    });

    it('should call git with correct arguments', async () => {
      const promise = simpleGitLog('/test/workspace', 50);

      setTimeout(() => {
        mockProcess.stdout.emit('data', '');
        mockProcess.emit('close', 0);
      }, 0);

      await promise;

      expect(mockSpawn).toHaveBeenCalledWith(
        'git',
        ['log', '--oneline', '--pretty=format:%H|%an|%ad|%s', '--date=iso', '--name-only', '-50'],
        {
          cwd: '/test/workspace',
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );
    });

    it('should use default limit when not specified', async () => {
      const promise = simpleGitLog('/test/workspace');

      setTimeout(() => {
        mockProcess.stdout.emit('data', '');
        mockProcess.emit('close', 0);
      }, 0);

      await promise;

      expect(mockSpawn).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-50']),
        expect.any(Object)
      );
    });

    it('should handle git command failures', async () => {
      const promise = simpleGitLog('/test/workspace', 10);

      setTimeout(() => {
        mockProcess.stderr.emit('data', 'fatal: not a git repository');
        mockProcess.emit('close', 128);
      }, 0);

      await expect(promise).rejects.toThrow('Git command failed: fatal: not a git repository');
    });

    it('should handle spawn errors', async () => {
      mockSpawn.mockImplementation(() => {
        const errorProcess = new EventEmitter();
        // add error listener before emitting to prevent uncaught exception
        (errorProcess as any).stdout = new EventEmitter();
        (errorProcess as any).stderr = new EventEmitter();
        errorProcess.on('error', () => {});
        setTimeout(() => errorProcess.emit('error', new Error('Command not found')), 0);
        return errorProcess;
      });

      await expect(simpleGitLog('/test/workspace', 10)).rejects.toThrow(
        'Failed to spawn git process: Command not found'
      );
    });

    it('should handle empty git log output', async () => {
      const promise = simpleGitLog('/test/workspace', 10);

      setTimeout(() => {
        mockProcess.stdout.emit('data', '');
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;
      expect(result).toHaveLength(0);
    });

    it('should handle malformed git log entries', async () => {
      const mockOutput = `malformed line without pipes
abc123|John Doe|2023-01-01|good entry
another malformed line`;

      const promise = simpleGitLog('/test/workspace', 10);

      setTimeout(() => {
        mockProcess.stdout.emit('data', mockOutput);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;
      expect(result).toHaveLength(1);
      expect(result[0].hash).toBe('abc123');
    });

    it('should handle entries with no files', async () => {
      const mockOutput = `abc123|John Doe|2023-01-01 12:00:00|empty commit`;

      const promise = simpleGitLog('/test/workspace', 10);

      setTimeout(() => {
        mockProcess.stdout.emit('data', mockOutput);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;
      expect(result).toHaveLength(1);
      expect(result[0].files).toEqual([]);
    });

    it('should trim whitespace from files', async () => {
      const mockOutput = `abc123|John Doe|2023-01-01 12:00:00|commit with files
src/file1.ts
src/file2.ts	`;

      const promise = simpleGitLog('/test/workspace', 10);

      setTimeout(() => {
        mockProcess.stdout.emit('data', mockOutput);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;
      expect(result[0].files).toEqual(['src/file1.ts', 'src/file2.ts']);
    });
  });

  describe('getCurrentBranch', () => {
    it('should return current branch name', async () => {
      const promise = getCurrentBranch('/test/workspace');

      setTimeout(() => {
        mockProcess.stdout.emit('data', 'feature/new-feature\n');
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;
      expect(result).toBe('feature/new-feature');
    });

    it('should call git with correct arguments', async () => {
      const promise = getCurrentBranch('/test/workspace');

      setTimeout(() => {
        mockProcess.stdout.emit('data', 'main');
        mockProcess.emit('close', 0);
      }, 0);

      await promise;

      expect(mockSpawn).toHaveBeenCalledWith('git', ['branch', '--show-current'], {
        cwd: '/test/workspace',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    });

    it('should handle git command failures', async () => {
      const promise = getCurrentBranch('/test/workspace');

      setTimeout(() => {
        mockProcess.stderr.emit('data', 'fatal: not a git repository');
        mockProcess.emit('close', 128);
      }, 0);

      await expect(promise).rejects.toThrow('Git command failed: fatal: not a git repository');
    });

    it('should handle spawn errors', async () => {
      mockSpawn.mockImplementation(() => {
        const errorProcess = new EventEmitter();
        // add error listener before emitting to prevent uncaught exception
        (errorProcess as any).stdout = new EventEmitter();
        (errorProcess as any).stderr = new EventEmitter();
        errorProcess.on('error', () => {});
        setTimeout(() => errorProcess.emit('error', new Error('Command not found')), 0);
        return errorProcess;
      });

      await expect(getCurrentBranch('/test/workspace')).rejects.toThrow(
        'Failed to spawn git process: Command not found'
      );
    });

    it('should trim whitespace from branch name', async () => {
      const promise = getCurrentBranch('/test/workspace');

      setTimeout(() => {
        mockProcess.stdout.emit('data', '  main  \n');
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;
      expect(result).toBe('main');
    });

    it('should handle empty output', async () => {
      const promise = getCurrentBranch('/test/workspace');

      setTimeout(() => {
        mockProcess.stdout.emit('data', '');
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;
      expect(result).toBe('');
    });
  });

  describe('parseGitLog function', () => {
    it('should handle commits with body text between entries', async () => {
      const mockOutput = `abc123|John Doe|2023-01-01 12:00:00|feat: add feature
src/file1.ts
src/file2.ts

def456|Jane Smith|2023-01-02 15:30:00|fix: bug fix
src/file3.ts`;

      const promise = simpleGitLog('/test/workspace', 10);

      setTimeout(() => {
        mockProcess.stdout.emit('data', mockOutput);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;
      expect(result).toHaveLength(2);
      expect(result[0].files).toEqual(['src/file1.ts', 'src/file2.ts']);
      expect(result[1].files).toEqual(['src/file3.ts']);
    });
  });

  describe('error scenarios', () => {
    it('should handle partial data chunks', async () => {
      const firstChunk = 'abc123|John Doe|2023-01-01 12:';
      const secondChunk = '00:00|commit message\nsrc/file.ts';

      const promise = simpleGitLog('/test/workspace', 10);

      setTimeout(() => {
        mockProcess.stdout.emit('data', firstChunk);
        mockProcess.stdout.emit('data', secondChunk);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;
      expect(result).toHaveLength(1);
      expect(result[0].hash).toBe('abc123');
      expect(result[0].files).toEqual(['src/file.ts']);
    });

    it('should handle stderr data without immediate failure', async () => {
      const promise = simpleGitLog('/test/workspace', 10);

      setTimeout(() => {
        mockProcess.stderr.emit('data', 'warning: some warning\n');
        mockProcess.stdout.emit('data', 'abc123|John|2023-01-01|commit\n');
        mockProcess.emit('close', 0); // success despite stderr
      }, 0);

      const result = await promise;
      expect(result).toHaveLength(1);
    });
  });

  describe('security: input validation', () => {
    describe('detectRevertCommits', () => {
      it('should accept valid ISO date for sinceDate', async () => {
        const mockOutput = 'abc123|2023-01-15 10:00:00|Revert PR #123';
        const promise = detectRevertCommits('/test/workspace', '#123', '2023-01-01T00:00:00Z');

        setTimeout(() => {
          mockProcess.stdout.emit('data', mockOutput);
          mockProcess.emit('close', 0);
        }, 0);

        const result = await promise;
        expect(result).not.toBeNull();
      });

      it('should reject invalid date format', async () => {
        await expect(
          detectRevertCommits('/test/workspace', '#123', 'invalid-date')
        ).rejects.toThrow('Invalid sinceDate');
      });

      it('should reject injection attempt in date', async () => {
        await expect(
          detectRevertCommits('/test/workspace', '#123', '2023-01-15; rm -rf /')
        ).rejects.toThrow('Invalid sinceDate');
      });

      it('should reject injection attempt in PR reference', async () => {
        const promise = detectRevertCommits('/test/workspace', '#123; whoami', '2023-01-01');

        setTimeout(() => {
          mockProcess.stdout.emit('data', '');
          mockProcess.emit('close', 0);
        }, 0);

        const result = await promise;
        expect(result).toBeNull(); // Invalid PR reference returns null
      });

      it('should work without sinceDate parameter', async () => {
        const mockOutput = '';
        const promise = detectRevertCommits('/test/workspace', '#123');

        setTimeout(() => {
          mockProcess.stdout.emit('data', mockOutput);
          mockProcess.emit('close', 0);
        }, 0);

        const result = await promise;
        expect(result).toBeNull(); // no matches
      });

      it('should sanitize PR reference formats', async () => {
        const mockOutput = '';
        const promise = detectRevertCommits('/test/workspace', 'owner/repo#456', '2023-01-01');

        setTimeout(() => {
          mockProcess.stdout.emit('data', mockOutput);
          mockProcess.emit('close', 0);
        }, 0);

        const result = await promise;
        // Should not throw, sanitization extracts just the number
        expect(result).toBeNull();
      });
    });

    describe('detectBugFixCommits', () => {
      it('should accept valid ISO date for mergeDate', async () => {
        const mockOutput = '';
        const promise = detectBugFixCommits('/test/workspace', '#123', '2023-01-15T10:00:00Z', 7);

        setTimeout(() => {
          mockProcess.stdout.emit('data', mockOutput);
          mockProcess.emit('close', 0);
        }, 0);

        const result = await promise;
        expect(result).toBeNull(); // no matches
      });

      it('should reject invalid date format', async () => {
        await expect(
          detectBugFixCommits('/test/workspace', '#123', 'invalid-date', 7)
        ).rejects.toThrow('Invalid mergeDate');
      });

      it('should reject injection attempt in date', async () => {
        await expect(
          detectBugFixCommits('/test/workspace', '#123', '2023-01-15`whoami`', 7)
        ).rejects.toThrow('Invalid mergeDate');
      });

      it('should reject injection attempt in PR reference', async () => {
        await expect(
          detectBugFixCommits('/test/workspace', '#123$(id)', '2023-01-15T00:00:00Z', 7)
        ).rejects.toThrow('Invalid PR reference');
      });
    });

    describe('spawn usage', () => {
      it('should always use spawn with array arguments (not string)', () => {
        const promise = simpleGitLog('/test/workspace', 10);

        setTimeout(() => {
          mockProcess.stdout.emit('data', '');
          mockProcess.emit('close', 0);
        }, 0);

        promise.then(() => {
          // Verify spawn was called with array (second argument)
          expect(mockSpawn).toHaveBeenCalledWith('git', expect.any(Array), expect.any(Object));

          // Verify shell: false (should not have shell: true)
          const callArgs = mockSpawn.mock.calls[0];
          const options = callArgs[2];
          expect(options.shell).not.toBe(true);
        });
      });

      it('should never concatenate user input into command strings', async () => {
        const promise = detectRevertCommits('/test/workspace', '#123', '2023-01-01');

        setTimeout(() => {
          mockProcess.stdout.emit('data', '');
          mockProcess.emit('close', 0);
        }, 0);

        await promise;

        // Verify the date is passed as part of an array element, not concatenated command
        const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
        expect(callArgs[1]).toBeInstanceOf(Array);
        expect(callArgs[1].some((arg: string) => arg.includes('--since='))).toBe(true);
      });
    });
  });

  describe('extractPRNumberFromBranch', () => {
    it('should extract PR number from gh-123 pattern', () => {
      expect(extractPRNumberFromBranch('gh-123')).toBe('123');
    });

    it('should extract PR number from GH-456 pattern', () => {
      expect(extractPRNumberFromBranch('GH-456')).toBe('456');
    });

    it('should extract PR number from feature/123-fix pattern', () => {
      expect(extractPRNumberFromBranch('feature/123-fix')).toBe('123');
    });

    it('should extract PR number from prefix/123 at end of string', () => {
      expect(extractPRNumberFromBranch('topic/42')).toBe('42');
    });

    it('should return null for empty branch name', () => {
      expect(extractPRNumberFromBranch('')).toBeNull();
    });

    it('should return null for branch without number patterns', () => {
      expect(extractPRNumberFromBranch('main')).toBeNull();
    });

    it('should extract from feature/PR-123 pattern', () => {
      expect(extractPRNumberFromBranch('feature/PR-123')).toBe('123');
    });

    it('should extract from bugfix/PR-789 pattern', () => {
      expect(extractPRNumberFromBranch('bugfix/PR-789')).toBe('789');
    });

    it('should extract from PR123 at start', () => {
      expect(extractPRNumberFromBranch('PR123')).toBe('123');
    });

    it('should extract from pr-456 at start', () => {
      expect(extractPRNumberFromBranch('pr-456')).toBe('456');
    });
  });

  describe('detectCleanMerge', () => {
    it('should return clean result when no reverts or bug fixes found', async () => {
      // detectCleanMerge calls detectRevertCommits then detectBugFixCommits
      // each spawns a separate git process, so we need two mock processes
      const firstProcess = new EventEmitter() as any;
      firstProcess.stdout = new EventEmitter();
      firstProcess.stderr = new EventEmitter();

      const secondProcess = new EventEmitter() as any;
      secondProcess.stdout = new EventEmitter();
      secondProcess.stderr = new EventEmitter();

      mockSpawn.mockReturnValueOnce(firstProcess).mockReturnValueOnce(secondProcess);

      const promise = detectCleanMerge('/test/workspace', '#100', '2023-01-01T00:00:00Z');

      // first spawn: detectRevertCommits - return empty (no reverts)
      setTimeout(() => {
        firstProcess.stdout.emit('data', '');
        firstProcess.emit('close', 0);
      }, 0);

      // second spawn: detectBugFixCommits - return empty (no bug fixes)
      setTimeout(() => {
        secondProcess.stdout.emit('data', '');
        secondProcess.emit('close', 0);
      }, 10);

      const result = await promise;

      expect(result).not.toBeNull();
      expect(result!.commits).toEqual([]);
      expect(result!.keywords).toEqual(['clean', 'stable']);
      expect(result!.confidence).toBe(0.7);
      expect(result!.firstDetectedDate).toBe('2023-01-01T00:00:00Z');
    });

    it('should return null when reverts are found', async () => {
      const mockOutput = 'abc123|2023-01-15 10:00:00|Revert #100 changes';
      const promise = detectCleanMerge('/test/workspace', '#100', '2023-01-01T00:00:00Z');

      setTimeout(() => {
        mockProcess.stdout.emit('data', mockOutput);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;

      // reverts found, should return null (not clean)
      expect(result).toBeNull();
    });

    it('should return null when bug fixes are found after merge', async () => {
      // detectRevertCommits returns null (no reverts), detectBugFixCommits finds fixes
      const firstProcess = new EventEmitter() as any;
      firstProcess.stdout = new EventEmitter();
      firstProcess.stderr = new EventEmitter();

      const secondProcess = new EventEmitter() as any;
      secondProcess.stdout = new EventEmitter();
      secondProcess.stderr = new EventEmitter();

      mockSpawn.mockReturnValueOnce(firstProcess).mockReturnValueOnce(secondProcess);

      const promise = detectCleanMerge('/test/workspace', '#100', '2023-01-01T00:00:00Z');

      // first spawn: detectRevertCommits - no reverts
      setTimeout(() => {
        firstProcess.stdout.emit('data', '');
        firstProcess.emit('close', 0);
      }, 0);

      // second spawn: detectBugFixCommits - has bug fix referencing #100
      setTimeout(() => {
        secondProcess.stdout.emit('data', 'def456|2023-01-03 10:00:00|fix: hotfix for #100');
        secondProcess.emit('close', 0);
      }, 10);

      const result = await promise;

      // bug fixes found, should return null (not clean)
      expect(result).toBeNull();
    });
  });

  describe('detectRevertCommits', () => {
    it('should match commits referencing PR with # syntax', async () => {
      const mockOutput = 'abc123|2023-01-15 10:00:00|Revert #42 due to issues';
      const promise = detectRevertCommits('/test/workspace', '#42');

      setTimeout(() => {
        mockProcess.stdout.emit('data', mockOutput);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;

      expect(result).not.toBeNull();
      expect(result!.commits).toEqual(['abc123']);
      expect(result!.keywords).toContain('revert');
      expect(result!.firstDetectedDate).toBe('2023-01-15 10:00:00');
    });

    it('should match commits referencing PR with "PR" syntax', async () => {
      const mockOutput = 'def456|2023-02-01 12:00:00|Rollback PR 99 changes';
      const promise = detectRevertCommits('/test/workspace', '#99');

      setTimeout(() => {
        mockProcess.stdout.emit('data', mockOutput);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;

      expect(result).not.toBeNull();
      expect(result!.commits).toEqual(['def456']);
      expect(result!.keywords).toContain('rollback');
    });

    it('should deduplicate keywords across multiple commits', async () => {
      const mockOutput =
        'abc123|2023-01-15 10:00:00|Revert #50 first attempt\n' +
        'def456|2023-01-16 10:00:00|Revert #50 second attempt';
      const promise = detectRevertCommits('/test/workspace', '#50');

      setTimeout(() => {
        mockProcess.stdout.emit('data', mockOutput);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;

      expect(result).not.toBeNull();
      expect(result!.commits).toHaveLength(2);
      // keywords should be deduplicated via Set
      expect(result!.keywords).toEqual(['revert']);
    });

    it('should return 0.9 confidence when revert keyword is present', async () => {
      const mockOutput = 'abc123|2023-01-15 10:00:00|Revert #77';
      const promise = detectRevertCommits('/test/workspace', '#77');

      setTimeout(() => {
        mockProcess.stdout.emit('data', mockOutput);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;

      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.9);
    });

    it('should return 0.9 confidence when rollback keyword is present', async () => {
      const mockOutput = 'abc123|2023-01-15 10:00:00|Rollback #88';
      const promise = detectRevertCommits('/test/workspace', '#88');

      setTimeout(() => {
        mockProcess.stdout.emit('data', mockOutput);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;

      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.9);
    });

    it('should return null when no commits reference the PR', async () => {
      // commits contain revert keyword but reference a different PR
      const mockOutput = 'abc123|2023-01-15 10:00:00|Revert #999 unrelated';
      const promise = detectRevertCommits('/test/workspace', '#1');

      setTimeout(() => {
        mockProcess.stdout.emit('data', mockOutput);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;

      expect(result).toBeNull();
    });

    it('should collect both revert and rollback keywords from different commits', async () => {
      const mockOutput =
        'abc123|2023-01-15 10:00:00|Revert #33 first\n' +
        'def456|2023-01-16 10:00:00|Rollback #33 second';
      const promise = detectRevertCommits('/test/workspace', '#33');

      setTimeout(() => {
        mockProcess.stdout.emit('data', mockOutput);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;

      expect(result).not.toBeNull();
      expect(result!.keywords).toContain('revert');
      expect(result!.keywords).toContain('rollback');
      expect(result!.keywords).toHaveLength(2);
    });

    it('should reject on git command failure', async () => {
      const promise = detectRevertCommits('/test/workspace', '#1');

      setTimeout(() => {
        mockProcess.stderr.emit('data', 'fatal: bad default revision');
        mockProcess.emit('close', 128);
      }, 0);

      await expect(promise).rejects.toThrow('Git command failed');
    });

    it('should handle spawn error for detectRevertCommits', async () => {
      mockSpawn.mockImplementation(() => {
        const errorProcess = new EventEmitter();
        (errorProcess as any).stdout = new EventEmitter();
        (errorProcess as any).stderr = new EventEmitter();
        errorProcess.on('error', () => {});
        setTimeout(() => errorProcess.emit('error', new Error('Command not found')), 0);
        return errorProcess;
      });

      await expect(detectRevertCommits('/test/workspace', '#1')).rejects.toThrow(
        'Failed to spawn git process: Command not found'
      );
    });
  });

  describe('branch coverage: detectBugFixCommits keyword confidence', () => {
    it('should return 0.9 confidence for hotfix keyword', async () => {
      const mockOutput = 'abc123|2023-01-20 10:00:00|hotfix for #10';
      const promise = detectBugFixCommits('/test/workspace', '#10', '2023-01-15T00:00:00Z', 7);

      setTimeout(() => {
        mockProcess.stdout.emit('data', mockOutput);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.9);
      expect(result!.keywords).toContain('hotfix');
    });

    it('should return 0.8 confidence for bug keyword', async () => {
      const mockOutput = 'abc123|2023-01-20 10:00:00|bug in #20';
      const promise = detectBugFixCommits('/test/workspace', '#20', '2023-01-15T00:00:00Z', 7);

      setTimeout(() => {
        mockProcess.stdout.emit('data', mockOutput);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.8);
      expect(result!.keywords).toContain('bug');
    });

    it('should return 0.6 confidence for fix keyword only', async () => {
      const mockOutput = 'abc123|2023-01-20 10:00:00|fix something';
      const promise = detectBugFixCommits('/test/workspace', '#30', '2023-01-15T00:00:00Z', 7);

      setTimeout(() => {
        mockProcess.stdout.emit('data', mockOutput);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.6);
      expect(result!.keywords).toContain('fix');
    });

    it('should return null when no matching commits found', async () => {
      const mockOutput = 'abc123|2023-01-20 10:00:00|update docs';
      const promise = detectBugFixCommits('/test/workspace', '#40', '2023-01-15T00:00:00Z', 7);

      setTimeout(() => {
        mockProcess.stdout.emit('data', mockOutput);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;
      expect(result).toBeNull();
    });

    it('should collect firstDetectedDate from first matching commit', async () => {
      const mockOutput =
        'abc123|2023-01-16 10:00:00|fix for #50\n' +
        'def456|2023-01-17 10:00:00|another fix for #50';
      const promise = detectBugFixCommits('/test/workspace', '#50', '2023-01-15T00:00:00Z', 7);

      setTimeout(() => {
        mockProcess.stdout.emit('data', mockOutput);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;
      expect(result).not.toBeNull();
      expect(result!.firstDetectedDate).toBe('2023-01-16 10:00:00');
    });

    it('should handle spawn error for detectBugFixCommits', async () => {
      mockSpawn.mockImplementation(() => {
        const errorProcess = new EventEmitter();
        (errorProcess as any).stdout = new EventEmitter();
        (errorProcess as any).stderr = new EventEmitter();
        errorProcess.on('error', () => {});
        setTimeout(() => errorProcess.emit('error', new Error('Command not found')), 0);
        return errorProcess;
      });

      await expect(
        detectBugFixCommits('/test/workspace', '#1', '2023-01-15T00:00:00Z', 7)
      ).rejects.toThrow('Failed to spawn git process: Command not found');
    });

    it('should reject on git command failure for detectBugFixCommits', async () => {
      const promise = detectBugFixCommits('/test/workspace', '#1', '2023-01-15T00:00:00Z', 7);

      setTimeout(() => {
        mockProcess.stderr.emit('data', 'fatal: error');
        mockProcess.emit('close', 128);
      }, 0);

      await expect(promise).rejects.toThrow('Git command failed');
    });
  });

  describe('branch coverage: extractPRNumberFromBranch additional patterns', () => {
    it('should extract from hotfix/123-fix pattern', () => {
      expect(extractPRNumberFromBranch('hotfix/123-fix')).toBe('123');
    });

    it('should extract from fix/456 pattern', () => {
      expect(extractPRNumberFromBranch('fix/456')).toBe('456');
    });

    it('should return null for branch with numbers over 5 digits after slash', () => {
      // pattern4 limits to 1-5 digits
      expect(extractPRNumberFromBranch('topic/123456')).toBeNull();
    });

    it('should extract from feature/PR123 without dash', () => {
      expect(extractPRNumberFromBranch('feature/PR123')).toBe('123');
    });
  });

  describe('branch coverage: parseGitLog line with < 4 parts', () => {
    it('should skip lines with fewer than 4 pipe-separated parts', async () => {
      const mockOutput = 'hash|author|date\ngood|parts|has|four fields\nsrc/file.ts';

      const promise = simpleGitLog('/test/workspace', 10);

      setTimeout(() => {
        mockProcess.stdout.emit('data', mockOutput);
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;
      // first line has 3 parts (skip), second has 4 parts (valid), third is a file for the second
      expect(result).toHaveLength(1);
      expect(result[0].hash).toBe('good');
      expect(result[0].files).toEqual(['src/file.ts']);
    });
  });

  describe('branch coverage: detectRevertCommits with sinceDate param', () => {
    it('should include --since flag when sinceDate is provided', async () => {
      const promise = detectRevertCommits('/test/workspace', '#1', '2023-06-01T00:00:00Z');

      setTimeout(() => {
        mockProcess.stdout.emit('data', '');
        mockProcess.emit('close', 0);
      }, 0);

      await promise;

      const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
      expect(callArgs[1]).toContain('--since=2023-06-01T00:00:00Z');
    });

    it('should not include --since flag when sinceDate is omitted', async () => {
      const promise = detectRevertCommits('/test/workspace', '#1');

      setTimeout(() => {
        mockProcess.stdout.emit('data', '');
        mockProcess.emit('close', 0);
      }, 0);

      await promise;

      const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
      const hasSince = callArgs[1].some((arg: string) => arg.startsWith('--since='));
      expect(hasSince).toBe(false);
    });
  });
});
