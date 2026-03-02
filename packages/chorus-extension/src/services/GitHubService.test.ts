import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubService } from './GitHubService';
import { Octokit } from '@octokit/rest';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';

// mock dependencies
vi.mock('child_process');
vi.mock('@octokit/rest');

// mock vscode module
vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
  },
  Uri: {
    parse: vi.fn((url: string) => ({ toString: () => url })),
  },
  commands: {
    executeCommand: vi.fn(),
  },
}));

describe('GitHubService', () => {
  let mockContext: any;
  let mockOctokit: any;
  let mockSpawn: any;
  let mockProcess: any;
  let githubService: GitHubService;

  beforeEach(() => {
    // mock timers for retry backoff tests
    vi.useFakeTimers();
    // mock extension context with secret storage
    mockContext = {
      secrets: {
        get: vi.fn().mockResolvedValue(undefined),
        store: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };

    // mock octokit instance
    mockOctokit = {
      rest: {
        pulls: {
          get: vi.fn(),
          listReviews: vi.fn(),
        },
        issues: {
          listComments: vi.fn(),
          createComment: vi.fn(),
        },
        rateLimit: {
          get: vi.fn().mockResolvedValue({
            data: {
              rate: {
                limit: 5000,
                remaining: 4999,
                reset: Math.floor(Date.now() / 1000) + 3600,
                used: 1,
              },
            },
          }),
        },
      },
    };

    // mock Octokit constructor
    const MockOctokit = vi.mocked(Octokit);
    MockOctokit.prototype = mockOctokit as any;
    (Octokit as any).mockImplementation(() => mockOctokit);

    // mock child_process spawn
    mockProcess = new EventEmitter();
    mockProcess.stdout = new EventEmitter();
    mockProcess.stderr = new EventEmitter();
    mockSpawn = vi.mocked(spawn);
    mockSpawn.mockReturnValue(mockProcess);

    // create service instance
    githubService = new GitHubService(mockContext);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('setToken', () => {
    it('should store token in secret storage', async () => {
      await githubService.setToken('ghp_test123');

      expect(mockContext.secrets.store).toHaveBeenCalledWith('github.token', 'ghp_test123');
    });

    it('should delete token from secret storage when set to undefined', async () => {
      await githubService.setToken(undefined);

      expect(mockContext.secrets.delete).toHaveBeenCalledWith('github.token');
    });

    it('should clear cache when token changes', async () => {
      // populate cache first
      const pr = {
        number: 123,
        title: 'Test PR',
        body: 'Test body',
        state: 'open' as const,
        html_url: 'https://github.com/test/repo/pull/123',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-02T00:00:00Z',
        merged_at: null,
        user: { login: 'testuser', avatar_url: 'https://example.com/avatar' },
        head: { ref: 'feature', sha: 'abc123' },
        base: { ref: 'main', sha: 'def456' },
        labels: [],
        draft: false,
      };

      mockOctokit.rest.pulls.get.mockResolvedValue({ data: pr });

      await githubService.getPullRequest('test', 'repo', 123);
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(1);

      // call again - should use cache
      await githubService.getPullRequest('test', 'repo', 123);
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(1);

      // set new token - should clear cache
      await githubService.setToken('ghp_new_token');

      // call again - should make new API call
      await githubService.getPullRequest('test', 'repo', 123);
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('loadToken', () => {
    it('should load token from secret storage on initialization', async () => {
      mockContext.secrets.get.mockResolvedValue('ghp_stored_token');

      await githubService.loadToken();

      expect(mockContext.secrets.get).toHaveBeenCalledWith('github.token');
    });
  });

  describe('detectGitHubRepo', () => {
    beforeEach(() => {
      // use real timers for spawn tests
      vi.useRealTimers();
    });

    afterEach(() => {
      // restore fake timers for other tests
      vi.useFakeTimers();
    });

    it('should detect github repo from https url', async () => {
      const promise = githubService.detectGitHubRepo('/test/workspace');

      setTimeout(() => {
        mockProcess.stdout.emit('data', 'https://github.com/facebook/react.git');
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;

      expect(result).toEqual({
        owner: 'facebook',
        repo: 'react',
      });
    });

    it('should detect github repo from ssh url', async () => {
      const promise = githubService.detectGitHubRepo('/test/workspace');

      setTimeout(() => {
        mockProcess.stdout.emit('data', 'git@github.com:microsoft/vscode.git');
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;

      expect(result).toEqual({
        owner: 'microsoft',
        repo: 'vscode',
      });
    });

    it('should return null for non-github remotes', async () => {
      const promise = githubService.detectGitHubRepo('/test/workspace');

      setTimeout(() => {
        mockProcess.stdout.emit('data', 'https://gitlab.com/test/repo.git');
        mockProcess.emit('close', 0);
      }, 0);

      const result = await promise;

      expect(result).toBeNull();
    });

    it('should handle git process error gracefully', async () => {
      const promise = githubService.detectGitHubRepo('/test/workspace');

      setTimeout(() => {
        mockProcess.emit('error', new Error('ENOENT'));
      }, 0);

      const result = await promise;

      expect(result).toBeNull();
    });

    it('should cache repository detection results', async () => {
      // first call
      const promise1 = githubService.detectGitHubRepo('/test/workspace');
      setTimeout(() => {
        mockProcess.stdout.emit('data', 'https://github.com/test/repo.git');
        mockProcess.emit('close', 0);
      }, 0);
      await promise1;

      expect(mockSpawn).toHaveBeenCalledTimes(1);

      // second call - should use cache
      await githubService.detectGitHubRepo('/test/workspace');
      expect(mockSpawn).toHaveBeenCalledTimes(1); // no additional spawn
    });
  });

  describe('getPullRequest', () => {
    it('should fetch and return pull request data', async () => {
      const mockPR = {
        number: 123,
        title: 'Add new feature',
        body: 'Description of feature',
        state: 'open',
        html_url: 'https://github.com/test/repo/pull/123',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-02T00:00:00Z',
        merged_at: null,
        user: {
          login: 'contributor',
          avatar_url: 'https://avatars.githubusercontent.com/u/123',
        },
        head: {
          ref: 'feature-branch',
          sha: 'abc123def',
        },
        base: {
          ref: 'main',
          sha: 'def456abc',
        },
        labels: [
          { name: 'enhancement', color: '00ff00' },
          { name: 'in-review', color: 'ff0000' },
        ],
        draft: false,
      };

      mockOctokit.rest.pulls.get.mockResolvedValue({ data: mockPR });

      const result = await githubService.getPullRequest('test', 'repo', 123);

      expect(result).toEqual({
        number: 123,
        title: 'Add new feature',
        body: 'Description of feature',
        state: 'open',
        html_url: 'https://github.com/test/repo/pull/123',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-02T00:00:00Z',
        merged_at: null,
        user: {
          login: 'contributor',
          avatar_url: 'https://avatars.githubusercontent.com/u/123',
        },
        head: {
          ref: 'feature-branch',
          sha: 'abc123def',
        },
        base: {
          ref: 'main',
          sha: 'def456abc',
        },
        labels: [
          { name: 'enhancement', color: '00ff00' },
          { name: 'in-review', color: 'ff0000' },
        ],
        draft: false,
      });

      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledWith({
        owner: 'test',
        repo: 'repo',
        pull_number: 123,
      });
    });

    it('should cache pull request data', async () => {
      const mockPR = {
        number: 123,
        title: 'Test PR',
        body: null,
        state: 'open',
        html_url: 'https://github.com/test/repo/pull/123',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-02T00:00:00Z',
        merged_at: null,
        user: { login: 'testuser', avatar_url: '' },
        head: { ref: 'feature', sha: 'abc' },
        base: { ref: 'main', sha: 'def' },
        labels: [],
        draft: false,
      };

      mockOctokit.rest.pulls.get.mockResolvedValue({ data: mockPR });

      // first call
      await githubService.getPullRequest('test', 'repo', 123);
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(1);

      // second call - should use cache
      await githubService.getPullRequest('test', 'repo', 123);
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(1);
    });

    it('should return null on API error', async () => {
      mockOctokit.rest.pulls.get.mockRejectedValue(new Error('API error'));

      const result = await githubService.getPullRequest('test', 'repo', 123);

      expect(result).toBeNull();
    });

    it('should show warning for rate limit errors', async () => {
      const rateLimitError = new Error('rate limit exceeded');
      (rateLimitError as any).status = 403;
      (rateLimitError as any).message = 'API rate limit exceeded';

      mockOctokit.rest.pulls.get.mockRejectedValue(rateLimitError);

      // start the request
      const promise = githubService.getPullRequest('test', 'repo', 123);

      // fast-forward through all retry delays
      await vi.runAllTimersAsync();

      await promise;

      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    });
  });

  describe('getPRComments', () => {
    it('should fetch and return PR comments', async () => {
      const mockComments = [
        {
          id: 1,
          body: 'First comment',
          user: { login: 'user1', avatar_url: 'https://avatar1.com' },
          created_at: '2023-01-01T10:00:00Z',
          updated_at: '2023-01-01T10:00:00Z',
          html_url: 'https://github.com/test/repo/pull/123#issuecomment-1',
        },
        {
          id: 2,
          body: 'Second comment',
          user: { login: 'user2', avatar_url: 'https://avatar2.com' },
          created_at: '2023-01-02T10:00:00Z',
          updated_at: '2023-01-02T10:00:00Z',
          html_url: 'https://github.com/test/repo/pull/123#issuecomment-2',
        },
      ];

      mockOctokit.rest.issues.listComments.mockResolvedValue({ data: mockComments });

      const result = await githubService.getPRComments('test', 'repo', 123);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 1,
        body: 'First comment',
        user: { login: 'user1', avatar_url: 'https://avatar1.com' },
        created_at: '2023-01-01T10:00:00Z',
        updated_at: '2023-01-01T10:00:00Z',
        html_url: 'https://github.com/test/repo/pull/123#issuecomment-1',
      });
    });

    it('should return empty array on error', async () => {
      mockOctokit.rest.issues.listComments.mockRejectedValue(new Error('API error'));

      const result = await githubService.getPRComments('test', 'repo', 123);

      expect(result).toEqual([]);
    });
  });

  describe('getPRReviews', () => {
    it('should fetch and return PR reviews', async () => {
      const mockReviews = [
        {
          id: 1,
          user: { login: 'reviewer1', avatar_url: 'https://avatar1.com' },
          body: 'Looks good!',
          state: 'APPROVED',
          submitted_at: '2023-01-01T12:00:00Z',
          html_url: 'https://github.com/test/repo/pull/123#pullrequestreview-1',
        },
        {
          id: 2,
          user: { login: 'reviewer2', avatar_url: 'https://avatar2.com' },
          body: 'Please fix issues',
          state: 'CHANGES_REQUESTED',
          submitted_at: '2023-01-02T12:00:00Z',
          html_url: 'https://github.com/test/repo/pull/123#pullrequestreview-2',
        },
      ];

      mockOctokit.rest.pulls.listReviews.mockResolvedValue({ data: mockReviews });

      const result = await githubService.getPRReviews('test', 'repo', 123);

      expect(result).toHaveLength(2);
      expect(result[0].state).toBe('APPROVED');
      expect(result[1].state).toBe('CHANGES_REQUESTED');
    });

    it('should cache review data', async () => {
      mockOctokit.rest.pulls.listReviews.mockResolvedValue({ data: [] });

      await githubService.getPRReviews('test', 'repo', 123);
      await githubService.getPRReviews('test', 'repo', 123);

      expect(mockOctokit.rest.pulls.listReviews).toHaveBeenCalledTimes(1);
    });
  });

  describe('createPRComment', () => {
    it('should create comment on PR', async () => {
      mockOctokit.rest.issues.createComment.mockResolvedValue({
        data: { id: 123, body: 'Test comment' },
      });

      await githubService.createPRComment('test', 'repo', 123, 'Test comment');

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'test',
        repo: 'repo',
        issue_number: 123,
        body: 'Test comment',
      });
    });

    it('should invalidate comments cache after creating comment', async () => {
      mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
      mockOctokit.rest.issues.createComment.mockResolvedValue({ data: {} });

      // fetch comments to populate cache
      await githubService.getPRComments('test', 'repo', 123);
      expect(mockOctokit.rest.issues.listComments).toHaveBeenCalledTimes(1);

      // create comment - should invalidate cache
      await githubService.createPRComment('test', 'repo', 123, 'New comment');

      // fetch comments again - should make new API call
      await githubService.getPRComments('test', 'repo', 123);
      expect(mockOctokit.rest.issues.listComments).toHaveBeenCalledTimes(2);
    });

    it('should throw error on API failure', async () => {
      mockOctokit.rest.issues.createComment.mockRejectedValue(new Error('API error'));

      await expect(githubService.createPRComment('test', 'repo', 123, 'Test')).rejects.toThrow(
        'API error'
      );
    });

    it('should not invalidate cache when createComment fails', async () => {
      // populate comments cache first
      mockOctokit.rest.issues.listComments.mockResolvedValue({
        data: [
          {
            id: 1,
            body: 'cached',
            user: { login: 'u', avatar_url: '' },
            created_at: '',
            updated_at: '',
            html_url: '',
          },
        ],
      });
      await githubService.getPRComments('test', 'repo', 123);
      expect(mockOctokit.rest.issues.listComments).toHaveBeenCalledTimes(1);

      // make createComment fail - error happens in retryWithBackoff,
      // so cache.delete (which is after retryWithBackoff) is never reached
      mockOctokit.rest.issues.createComment.mockRejectedValue(new Error('Network error'));

      await expect(
        githubService.createPRComment('test', 'repo', 123, 'New comment')
      ).rejects.toThrow('Network error');

      // fetch comments again - cache should still be valid (no new API call)
      await githubService.getPRComments('test', 'repo', 123);
      expect(mockOctokit.rest.issues.listComments).toHaveBeenCalledTimes(1);
    });

    it('should show rate limit warning when createPRComment fails with 403', async () => {
      const rateLimitError = new Error('API rate limit exceeded');
      (rateLimitError as any).status = 403;
      (rateLimitError as any).message = 'API rate limit exceeded';

      mockOctokit.rest.issues.createComment.mockRejectedValue(rateLimitError);

      const promise = githubService.createPRComment('test', 'repo', 123, 'Test');

      // attach rejection handler before advancing timers to avoid unhandled rejection
      const resultPromise = expect(promise).rejects.toThrow();

      // fast-forward through retry delays
      await vi.runAllTimersAsync();

      await resultPromise;

      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    });
  });

  describe('parsePRReference', () => {
    it('should parse valid PR reference', () => {
      const result = githubService.parsePRReference('facebook/react#12345');

      expect(result).toEqual({
        owner: 'facebook',
        repo: 'react',
        number: 12345,
      });
    });

    it('should return null for invalid format', () => {
      expect(githubService.parsePRReference('invalid')).toBeNull();
      expect(githubService.parsePRReference('facebook/react')).toBeNull();
      expect(githubService.parsePRReference('#123')).toBeNull();
    });
  });

  describe('formatPRReference', () => {
    it('should format PR reference correctly', () => {
      const result = githubService.formatPRReference('facebook', 'react', 12345);

      expect(result).toBe('facebook/react#12345');
    });
  });

  describe('clearCache', () => {
    it('should clear all cached data', async () => {
      // populate cache
      mockOctokit.rest.pulls.get.mockResolvedValue({
        data: {
          number: 123,
          title: 'Test',
          body: null,
          state: 'open',
          html_url: '',
          created_at: '',
          updated_at: '',
          merged_at: null,
          user: { login: 'test', avatar_url: '' },
          head: { ref: '', sha: '' },
          base: { ref: '', sha: '' },
          labels: [],
          draft: false,
        },
      });

      await githubService.getPullRequest('test', 'repo', 123);
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(1);

      // clear cache
      githubService.clearCache();

      // fetch again - should make new API call
      await githubService.getPullRequest('test', 'repo', 123);
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('rate limiting', () => {
    it('should retry with exponential backoff on rate limit error', async () => {
      const rateLimitError = new Error('rate limit');
      (rateLimitError as any).status = 429;

      // fail twice, succeed on third attempt
      mockOctokit.rest.pulls.get
        .mockRejectedValueOnce(rateLimitError)
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({
          data: {
            number: 123,
            title: 'Test',
            body: null,
            state: 'open',
            html_url: '',
            created_at: '',
            updated_at: '',
            merged_at: null,
            user: { login: 'test', avatar_url: '' },
            head: { ref: '', sha: '' },
            base: { ref: '', sha: '' },
            labels: [],
            draft: false,
          },
        });

      // start the request
      const promise = githubService.getPullRequest('test', 'repo', 123);

      // fast-forward through all retry delays
      await vi.runAllTimersAsync();

      const result = await promise;

      expect(result).not.toBeNull();
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(3);
    });

    it('should fail after max retries', async () => {
      const rateLimitError = new Error('rate limit');
      (rateLimitError as any).status = 429;

      mockOctokit.rest.pulls.get.mockRejectedValue(rateLimitError);

      // start the request
      const promise = githubService.getPullRequest('test', 'repo', 123);

      // fast-forward through all retry delays
      await vi.runAllTimersAsync();

      const result = await promise;

      expect(result).toBeNull();
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(4); // initial + 3 retries
    });
  });

  describe('cache TTL', () => {
    it('should respect cache TTL and refetch expired data', async () => {
      // create service with very short TTL
      const shortTTLService = new GitHubService(mockContext, { cacheTTL: 50 }); // 50ms

      mockOctokit.rest.pulls.get.mockResolvedValue({
        data: {
          number: 123,
          title: 'Test',
          body: null,
          state: 'open',
          html_url: '',
          created_at: '',
          updated_at: '',
          merged_at: null,
          user: { login: 'test', avatar_url: '' },
          head: { ref: '', sha: '' },
          base: { ref: '', sha: '' },
          labels: [],
          draft: false,
        },
      });

      // first call
      await shortTTLService.getPullRequest('test', 'repo', 123);
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(1);

      // second call immediately - should use cache
      await shortTTLService.getPullRequest('test', 'repo', 123);
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(1);

      // advance time past TTL
      vi.advanceTimersByTime(100);

      // third call after TTL - should refetch
      await shortTTLService.getPullRequest('test', 'repo', 123);
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('updateRateLimit', () => {
    it('should handle rate limit check failure gracefully', async () => {
      // make rateLimit.get fail
      mockOctokit.rest.rateLimit.get.mockRejectedValue(new Error('Network error'));

      // getPullRequest calls updateRateLimit internally on success
      mockOctokit.rest.pulls.get.mockResolvedValue({
        data: {
          number: 123,
          title: 'Test',
          body: null,
          state: 'open',
          html_url: '',
          created_at: '',
          updated_at: '',
          merged_at: null,
          user: { login: 'test', avatar_url: '' },
          head: { ref: '', sha: '' },
          base: { ref: '', sha: '' },
          labels: [],
          draft: false,
        },
      });

      // should not throw despite updateRateLimit failure
      const result = await githubService.getPullRequest('test', 'repo', 123);
      expect(result).not.toBeNull();
    });
  });

  describe('checkRateLimit', () => {
    it('should show warning when remaining requests are below 10', async () => {
      // set rate limit info with low remaining count via a successful call
      mockOctokit.rest.rateLimit.get.mockResolvedValue({
        data: {
          rate: {
            limit: 5000,
            remaining: 5,
            reset: Math.floor(Date.now() / 1000) + 3600,
            used: 4995,
          },
        },
      });

      // first call to populate rate limit info
      mockOctokit.rest.pulls.get.mockResolvedValue({
        data: {
          number: 1,
          title: 'Test',
          body: null,
          state: 'open',
          html_url: '',
          created_at: '',
          updated_at: '',
          merged_at: null,
          user: { login: 'test', avatar_url: '' },
          head: { ref: '', sha: '' },
          base: { ref: '', sha: '' },
          labels: [],
          draft: false,
        },
      });

      await githubService.getPullRequest('test', 'repo', 1);

      // second call should trigger checkRateLimit warning
      mockOctokit.rest.pulls.get.mockResolvedValue({
        data: {
          number: 2,
          title: 'Test2',
          body: null,
          state: 'open',
          html_url: '',
          created_at: '',
          updated_at: '',
          merged_at: null,
          user: { login: 'test', avatar_url: '' },
          head: { ref: '', sha: '' },
          base: { ref: '', sha: '' },
          labels: [],
          draft: false,
        },
      });

      await githubService.getPullRequest('test', 'repo', 2);

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Rate Limit Low')
      );
    });
  });

  describe('retryWithBackoff edge cases', () => {
    it('should retry on ECONNRESET errors', async () => {
      const connResetError = new Error('connection reset');
      (connResetError as any).code = 'ECONNRESET';

      // fail once with ECONNRESET, then succeed
      mockOctokit.rest.pulls.get
        .mockRejectedValueOnce(connResetError)
        .mockResolvedValueOnce({
          data: {
            number: 123,
            title: 'Test',
            body: null,
            state: 'open',
            html_url: '',
            created_at: '',
            updated_at: '',
            merged_at: null,
            user: { login: 'test', avatar_url: '' },
            head: { ref: '', sha: '' },
            base: { ref: '', sha: '' },
            labels: [],
            draft: false,
          },
        });

      const promise = githubService.getPullRequest('test', 'repo', 123);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).not.toBeNull();
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(2);
    });

    it('should not retry on non-retryable errors (e.g. 404)', async () => {
      const notFoundError = new Error('Not Found');
      (notFoundError as any).status = 404;

      mockOctokit.rest.pulls.get.mockRejectedValue(notFoundError);

      const result = await githubService.getPullRequest('test', 'repo', 999);

      // should fail immediately without retries (only 1 call)
      expect(result).toBeNull();
      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledTimes(1);
    });
  });

  // ===== branch coverage: additional tests =====

  describe('branch coverage: constructor with token', () => {
    it('should create authenticated octokit when token is provided', () => {
      const service = new GitHubService(mockContext, { token: 'ghp_test_token' });
      // should not throw - octokit created with auth
      expect(service).toBeDefined();
    });
  });

  describe('branch coverage: loadToken when no token stored', () => {
    it('should not reinitialize octokit when no token in storage', async () => {
      mockContext.secrets.get.mockResolvedValue(undefined);

      await githubService.loadToken();

      // octokit should remain unauthenticated (constructor default)
      expect(mockContext.secrets.get).toHaveBeenCalledWith('github.token');
    });
  });

  describe('branch coverage: listPullRequests', () => {
    it('should fetch and return list of PRs', async () => {
      // add list mock to the pulls mock object
      mockOctokit.rest.pulls.list = vi.fn().mockResolvedValue({
        data: [
          {
            number: 1,
            title: 'PR 1',
            body: 'Body 1',
            state: 'open',
            html_url: 'https://github.com/test/repo/pull/1',
            created_at: '2023-01-01',
            updated_at: '2023-01-02',
            merged_at: null,
            user: { login: 'user1', avatar_url: '' },
            head: { ref: 'branch1', sha: 'sha1' },
            base: { ref: 'main', sha: 'sha2' },
            labels: [{ name: 'bug', color: 'ff0000' }],
            draft: false,
          },
          {
            number: 2,
            title: 'PR 2',
            body: null,
            state: 'closed',
            html_url: 'https://github.com/test/repo/pull/2',
            created_at: '2023-01-03',
            updated_at: '2023-01-04',
            merged_at: '2023-01-04',
            user: { login: 'user2', avatar_url: '' },
            head: { ref: 'branch2', sha: 'sha3' },
            base: { ref: 'main', sha: 'sha4' },
            labels: [],
            draft: true,
          },
        ],
      });

      const result = await githubService.listPullRequests('test', 'repo', 'open', 10);

      expect(result).toHaveLength(2);
      expect(result[0].number).toBe(1);
      expect(result[1].number).toBe(2);
    });

    it('should return empty array on error', async () => {
      mockOctokit.rest.pulls.list = vi.fn().mockRejectedValue(new Error('API error'));

      const result = await githubService.listPullRequests('test', 'repo');

      expect(result).toEqual([]);
    });

    it('should cache list PR results', async () => {
      mockOctokit.rest.pulls.list = vi.fn().mockResolvedValue({ data: [] });

      await githubService.listPullRequests('test', 'repo', 'open', 30);
      await githubService.listPullRequests('test', 'repo', 'open', 30);

      expect(mockOctokit.rest.pulls.list).toHaveBeenCalledTimes(1);
    });

    it('should handle labels as plain strings', async () => {
      mockOctokit.rest.pulls.list = vi.fn().mockResolvedValue({
        data: [
          {
            number: 3,
            title: 'PR with string labels',
            body: null,
            state: 'open',
            html_url: '',
            created_at: '',
            updated_at: '',
            merged_at: null,
            user: { login: 'u', avatar_url: '' },
            head: { ref: 'b', sha: 's1' },
            base: { ref: 'm', sha: 's2' },
            labels: ['bug', 'enhancement'],
            draft: false,
          },
        ],
      });

      const result = await githubService.listPullRequests('test', 'repo');

      expect(result[0].labels).toEqual([
        { name: 'bug', color: '' },
        { name: 'enhancement', color: '' },
      ]);
    });
  });

  describe('branch coverage: PR labels as strings', () => {
    it('should handle string labels in getPullRequest', async () => {
      mockOctokit.rest.pulls.get.mockResolvedValue({
        data: {
          number: 99,
          title: 'Test',
          body: null,
          state: 'open',
          html_url: '',
          created_at: '',
          updated_at: '',
          merged_at: null,
          user: { login: 'test', avatar_url: '' },
          head: { ref: 'b', sha: 's' },
          base: { ref: 'm', sha: 's' },
          labels: ['string-label', { name: 'obj-label', color: 'aabbcc' }],
          draft: undefined,
        },
      });

      const result = await githubService.getPullRequest('test', 'repo', 99);

      expect(result!.labels).toEqual([
        { name: 'string-label', color: '' },
        { name: 'obj-label', color: 'aabbcc' },
      ]);
      // draft should default to false when undefined
      expect(result!.draft).toBe(false);
    });
  });

  describe('branch coverage: getPRReviews error path', () => {
    it('should return empty array when reviews fetch fails', async () => {
      mockOctokit.rest.pulls.listReviews.mockRejectedValue(new Error('Network error'));

      const result = await githubService.getPRReviews('test', 'repo', 123);

      expect(result).toEqual([]);
    });
  });

  describe('branch coverage: showRateLimitWarning Configure Token selection', () => {
    it('should execute configureGitHubToken when user clicks Configure Token', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
        'Configure Token' as any
      );

      const rateLimitError = new Error('API rate limit exceeded');
      (rateLimitError as any).status = 403;
      (rateLimitError as any).message = 'API rate limit exceeded';

      mockOctokit.rest.pulls.get.mockRejectedValue(rateLimitError);

      const promise = githubService.getPullRequest('test', 'repo', 123);
      await vi.runAllTimersAsync();
      await promise;

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Rate Limit Exceeded'),
        'Configure Token'
      );
    });

    it('should not show rate limit warning for non-403 errors', async () => {
      const error = new Error('Server error');
      (error as any).status = 500;

      mockOctokit.rest.pulls.get.mockRejectedValue(error);

      await githubService.getPullRequest('test', 'repo', 123);

      // should not call showWarningMessage with rate limit text for 500 errors
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalledWith(
        expect.stringContaining('Rate Limit Exceeded'),
        'Configure Token'
      );
    });
  });

  describe('branch coverage: getGitRemoteUrl non-zero exit', () => {
    beforeEach(() => {
      vi.useRealTimers();
    });

    afterEach(() => {
      vi.useFakeTimers();
    });

    it('should return null when git process exits with non-zero code', async () => {
      const promise = githubService.detectGitHubRepo('/test/workspace');

      setTimeout(() => {
        mockProcess.emit('close', 128); // non-zero exit code
      }, 0);

      const result = await promise;
      expect(result).toBeNull();
    });
  });

  describe('getGitRemoteUrl timeout', () => {
    it('should return null when git process hangs past 5s timeout', async () => {
      // this test uses fake timers (from the outer beforeEach)
      mockProcess.kill = vi.fn();

      const promise = githubService.detectGitHubRepo('/test/workspace');

      // process never emits close - advance past the 5s timeout
      vi.advanceTimersByTime(5100);

      const result = await promise;

      expect(result).toBeNull();
      expect(mockProcess.kill).toHaveBeenCalled();
    });

    it('should resolve normally if process completes before timeout', async () => {
      const promise = githubService.detectGitHubRepo('/test/workspace');

      // emit data and close before timeout fires
      mockProcess.stdout.emit('data', 'https://github.com/test/repo.git');
      mockProcess.emit('close', 0);

      const result = await promise;

      expect(result).toEqual({
        owner: 'test',
        repo: 'repo',
      });
    });
  });
});
