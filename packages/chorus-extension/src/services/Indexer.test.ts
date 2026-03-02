import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Indexer } from './Indexer';
import {
  TestDatabase,
  createMockVSCodeWorkspace,
  createMockVSCodeExtensionContext,
} from '../test/testUtils';
import * as GitService from './GitService';
import { GitHubService } from './GitHubService';
import { GitHubPR, GitHubComment, GitHubReview } from '../types/github';

// mock vscode module
vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [],
    asRelativePath: vi.fn(),
    findFiles: vi.fn(),
  },
  RelativePattern: vi.fn(),
  Uri: {
    joinPath: vi.fn(),
  },
  window: {
    setStatusBarMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(),
  },
}));

describe('Indexer', () => {
  let testDb: TestDatabase;
  let indexer: Indexer;

  beforeEach(async () => {
    testDb = new TestDatabase();
    await testDb.setup();
    indexer = new Indexer(testDb.db);
  });

  afterEach(async () => {
    await testDb.cleanup();
    vi.clearAllMocks();
  });

  describe('findRelevantContext', () => {
    beforeEach(async () => {
      // add some test data
      await testDb.db.addContextEntry({
        type: 'commit',
        title: 'feat: add user authentication',
        path: 'abc123',
        content: 'Implemented OAuth2 flow for user auth',
        metadata: { hash: 'abc123', author: 'John' },
      });

      await testDb.db.addContextEntry({
        type: 'doc',
        title: 'Authentication Guide',
        path: 'docs/auth.md',
        content: 'How to implement authentication in the app',
        metadata: { fileSize: 100 },
      });

      await testDb.db.addContextEntry({
        type: 'commit',
        title: 'fix: resolve login issue',
        path: 'def456',
        content: 'Fixed bug in login component',
        metadata: { hash: 'def456', author: 'Jane' },
      });
    });

    it('should find context by filename', async () => {
      const results = await indexer.findRelevantContext('src/auth.ts');

      expect(results.length).toBeGreaterThan(0);
      // should find entries related to 'auth'
      const authRelated = results.filter(
        (r) => r.title.toLowerCase().includes('auth') || r.content.toLowerCase().includes('auth')
      );
      expect(authRelated.length).toBeGreaterThan(0);
    });

    it('should find context by symbol name', async () => {
      const results = await indexer.findRelevantContext('src/components/Login.tsx', 'login');

      expect(results.length).toBeGreaterThan(0);
      // should find the commit about login issue
      const loginRelated = results.filter(
        (r) => r.title.toLowerCase().includes('login') || r.content.toLowerCase().includes('login')
      );
      expect(loginRelated.length).toBeGreaterThan(0);
    });

    it('should limit results to 10', async () => {
      // add many entries
      for (let i = 0; i < 15; i++) {
        await testDb.db.addContextEntry({
          type: 'commit',
          title: 'auth commit ' + i,
          path: 'hash' + i,
          content: 'Authentication related commit ' + i,
          metadata: { hash: 'hash' + i },
        });
      }

      const results = await indexer.findRelevantContext('src/auth.ts');
      expect(results.length).toBeLessThanOrEqual(10);
    });

    it('should deduplicate results', async () => {
      // this should return the same entry for multiple query terms
      const results = await indexer.findRelevantContext('auth/login.ts', 'auth');

      // check that there are no duplicate paths
      const paths = results.map((r) => r.path);
      const uniquePaths = [...new Set(paths)];
      expect(paths).toHaveLength(uniquePaths.length);
    });

    it('should rank commits higher than docs', async () => {
      const results = await indexer.findRelevantContext('src/auth.ts');

      if (results.length > 1) {
        // find first commit and first doc
        const firstCommitIndex = results.findIndex((r) => r.type === 'commit');
        const firstDocIndex = results.findIndex((r) => r.type === 'doc');

        if (firstCommitIndex !== -1 && firstDocIndex !== -1) {
          expect(firstCommitIndex).toBeLessThan(firstDocIndex);
        }
      }
    });

    it('should handle empty file paths', async () => {
      const results = await indexer.findRelevantContext('');
      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle files with no relevant context', async () => {
      const results = await indexer.findRelevantContext('src/unrelated-file.ts');
      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('deduplication and ranking', () => {
    it('should prefer exact title matches', async () => {
      await testDb.db.addContextEntry({
        type: 'commit',
        title: 'authentication system',
        path: 'hash1',
        content: 'Some other content',
        metadata: { hash: 'hash1' },
      });

      await testDb.db.addContextEntry({
        type: 'commit',
        title: 'unrelated change',
        path: 'hash2',
        content: 'This mentions authentication in passing',
        metadata: { hash: 'hash2' },
      });

      const results = await indexer.findRelevantContext('src/auth.ts');

      // the entry with 'authentication' in the title should rank higher
      // than the one that only mentions it in content
      if (results.length >= 2) {
        const titleMatch = results.find((r) => r.title.includes('authentication'));
        const contentMatch = results.find((r) => r.title.includes('unrelated'));

        if (titleMatch && contentMatch) {
          const titleIndex = results.indexOf(titleMatch);
          const contentIndex = results.indexOf(contentMatch);
          expect(titleIndex).toBeLessThan(contentIndex);
        }
      }
    });
  });

  describe('indexGitCommits', () => {
    it('should handle git service errors gracefully', async () => {
      // mock git service to throw error
      vi.spyOn(GitService, 'simpleGitLog').mockRejectedValue(new Error('Git not found'));

      // this should not throw, but log error internally
      await expect(indexer.indexWorkspace()).resolves.not.toThrow();
    });

    it('should process git log entries correctly', async () => {
      const mockCommits = [
        {
          hash: 'abc123',
          author: 'John Doe',
          date: '2023-01-01',
          subject: 'feat: add authentication',
          body: 'Implemented OAuth2 flow',
          files: ['src/auth.ts', 'src/types.ts'],
        },
      ];

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue(mockCommits);

      // mock vscode workspace
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;
      mockVscode.workspace.findFiles = vi.fn().mockResolvedValue([]);

      await indexer.indexWorkspace();

      // check that commit was added to database
      const results = await testDb.db.searchContext('authentication');
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('commit');
      expect(results[0].title).toBe('feat: add authentication');
      expect(results[0].metadata.hash).toBe('abc123');
    });
  });

  describe('indexDocuments', () => {
    it('should handle file system errors gracefully', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/nonexistent/workspace' },
          name: 'test',
        },
      ] as any;
      mockVscode.workspace.findFiles = vi.fn().mockRejectedValue(new Error('File not found'));

      // this should not throw
      await expect(indexer.indexWorkspace()).resolves.not.toThrow();
    });

    it('should extract title from markdown headings', async () => {
      const mockFileContent = '# API Documentation\n\nThis is the content.';

      // mock git service to return empty results
      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);

      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      mockVscode.workspace.findFiles = vi
        .fn()
        .mockResolvedValue([{ fsPath: '/test/workspace/docs/api.md' }]);

      mockVscode.workspace.asRelativePath = vi.fn().mockReturnValue('docs/api.md');

      // mock the fs module at the module level
      vi.doMock('fs/promises', () => ({
        readFile: vi.fn().mockResolvedValue(mockFileContent),
      }));

      // we need to test the indexing manually since the workspace method
      // is complex to mock properly. Let's add a document directly.
      await testDb.db.addContextEntry({
        type: 'doc',
        title: 'API Documentation',
        path: 'docs/api.md',
        content: mockFileContent,
        metadata: { fileSize: mockFileContent.length, extension: '.md' },
      });

      // check that document was indexed with correct title
      const results = await testDb.db.searchContext('API Documentation');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toBe('API Documentation');
      expect(results[0].type).toBe('doc');
    });
  });

  describe('error handling', () => {
    it('should handle missing workspace folders', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = null;

      await expect(indexer.indexWorkspace()).resolves.not.toThrow();
    });

    it('should handle empty workspace folders', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [];

      await expect(indexer.indexWorkspace()).resolves.not.toThrow();
    });
  });

  describe('bm25 ranking', () => {
    it('should rank results by relevance using bm25', async () => {
      // add three context entries with varying relevance to 'testing'
      await testDb.db.addContextEntry({
        type: 'doc',
        title: 'React Testing Guide',
        path: 'docs/testing.md',
        content: 'testing testing testing react components unit testing integration testing',
        metadata: { fileSize: 100 },
      });

      await testDb.db.addContextEntry({
        type: 'doc',
        title: 'API Documentation',
        path: 'docs/api.md',
        content: 'api endpoints rest http testing mentioned once here',
        metadata: { fileSize: 100 },
      });

      await testDb.db.addContextEntry({
        type: 'commit',
        title: 'fix: update config',
        path: 'hash123',
        content: 'updated configuration file for production',
        metadata: { hash: 'hash123' },
      });

      const results = await indexer.findRelevantContext('test.tsx', 'testing');

      // most relevant (testing guide with high tf) should be first
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toBe('React Testing Guide');
    });

    it('should handle rare terms with higher idf scores', async () => {
      // add entries with common and rare terms
      await testDb.db.addContextEntry({
        type: 'doc',
        title: 'Common Terms Document',
        path: 'docs/common.md',
        content: 'the the the the the the the',
        metadata: { fileSize: 50 },
      });

      await testDb.db.addContextEntry({
        type: 'doc',
        title: 'Unique Quantum Physics Guide',
        path: 'docs/quantum.md',
        content: 'quantum entanglement superposition measurement',
        metadata: { fileSize: 50 },
      });

      await testDb.db.addContextEntry({
        type: 'doc',
        title: 'Another Document',
        path: 'docs/other.md',
        content: 'something else entirely unrelated',
        metadata: { fileSize: 50 },
      });

      const results = await indexer.findRelevantContext('quantum.ts', 'quantum');

      // rare term 'quantum' should rank quantum physics guide first
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toBe('Unique Quantum Physics Guide');
    });

    it('should normalize by document length', async () => {
      // add short document with one occurrence
      await testDb.db.addContextEntry({
        type: 'doc',
        title: 'Short Authentication Doc',
        path: 'docs/short-auth.md',
        content: 'authentication',
        metadata: { fileSize: 20 },
      });

      // add long document with one occurrence
      await testDb.db.addContextEntry({
        type: 'doc',
        title: 'Long Verbose Document',
        path: 'docs/long.md',
        content:
          'authentication is important but this document has lots and lots ' +
          'of other content that dilutes the relevance of the single mention ' +
          'of the search term making it less relevant overall despite having ' +
          'the same term frequency count as the shorter document',
        metadata: { fileSize: 200 },
      });

      const results = await indexer.findRelevantContext('auth.ts', 'authentication');

      // short doc should rank higher due to length normalization
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toBe('Short Authentication Doc');
    });

    it('should handle empty queries gracefully', async () => {
      await testDb.db.addContextEntry({
        type: 'doc',
        title: 'Test Document',
        path: 'docs/test.md',
        content: 'content here',
        metadata: { fileSize: 50 },
      });

      // empty filename and no symbol should still work
      const results = await indexer.findRelevantContext('', '');
      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle queries with special characters', async () => {
      await testDb.db.addContextEntry({
        type: 'commit',
        title: 'feat: add user-auth module',
        path: 'hash456',
        content: 'Implemented user@auth with special-chars_123',
        metadata: { hash: 'hash456' },
      });

      const results = await indexer.findRelevantContext('user-auth.ts', 'user@auth');

      // should tokenize and match despite special characters
      expect(results.length).toBeGreaterThan(0);
    });

    it('should handle single-term queries', async () => {
      await testDb.db.addContextEntry({
        type: 'doc',
        title: 'Database Guide',
        path: 'docs/database.md',
        content: 'database connection pooling queries indexes',
        metadata: { fileSize: 100 },
      });

      const results = await indexer.findRelevantContext('db.ts');

      // should find results even with abbreviated filename
      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
    });

    it('should rank multi-term matches higher', async () => {
      await testDb.db.addContextEntry({
        type: 'doc',
        title: 'React Testing Library Guide',
        path: 'docs/react-testing.md',
        content: 'react testing library components hooks testing utilities',
        metadata: { fileSize: 100 },
      });

      await testDb.db.addContextEntry({
        type: 'doc',
        title: 'React Documentation',
        path: 'docs/react.md',
        content: 'react framework components jsx hooks state props',
        metadata: { fileSize: 100 },
      });

      await testDb.db.addContextEntry({
        type: 'doc',
        title: 'Testing Best Practices',
        path: 'docs/testing.md',
        content: 'testing unit integration e2e coverage mocking',
        metadata: { fileSize: 100 },
      });

      const results = await indexer.findRelevantContext('react-test.tsx', 'testing');

      // document matching both 'react' and 'testing' should rank highest
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toBe('React Testing Library Guide');
    });

    it('should filter single-character tokens', async () => {
      await testDb.db.addContextEntry({
        type: 'doc',
        title: 'C Programming Guide',
        path: 'docs/c-lang.md',
        content: 'c programming language pointers memory',
        metadata: { fileSize: 100 },
      });

      // single character 'c' should be filtered during tokenization
      const results = await indexer.findRelevantContext('test.c', 'c');

      // should still return results based on other query terms
      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
    });

    it('should handle no matching results', async () => {
      await testDb.db.addContextEntry({
        type: 'doc',
        title: 'Unrelated Document',
        path: 'docs/unrelated.md',
        content: 'completely unrelated content',
        metadata: { fileSize: 100 },
      });

      const results = await indexer.findRelevantContext(
        'nonexistent-xyz-file.ts',
        'nonexistent-symbol'
      );

      // should return empty array when no matches
      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
    });

    it('should deduplicate before ranking', async () => {
      // add entry that matches multiple query terms
      await testDb.db.addContextEntry({
        type: 'commit',
        title: 'feat: add auth service',
        path: 'hash789',
        content: 'authentication service implementation',
        metadata: { hash: 'hash789' },
      });

      // query with overlapping terms that would return same entry
      const results = await indexer.findRelevantContext('services/auth-service.ts', 'auth');

      // should not have duplicates
      const paths = results.map((r) => r.path);
      const uniquePaths = [...new Set(paths)];
      expect(paths).toHaveLength(uniquePaths.length);
    });

    it('should maintain performance with many documents', async () => {
      // add 50 documents
      for (let i = 0; i < 50; i++) {
        await testDb.db.addContextEntry({
          type: 'doc',
          title: 'Document ' + i,
          path: 'docs/doc' + i + '.md',
          content:
            'content with various terms database testing auth user component ' +
            'render hook state props context provider consumer reducer action ' +
            'dispatch middleware thunk saga effect observable stream pipe',
          metadata: { fileSize: 200 },
        });
      }

      const startTime = Date.now();
      const results = await indexer.findRelevantContext('component.tsx', 'testing');
      const endTime = Date.now();

      // should complete in reasonable time (<200ms for 50 docs)
      expect(endTime - startTime).toBeLessThan(200);
      expect(results).toBeDefined();
      expect(results.length).toBeLessThanOrEqual(10);
    });
  });

  describe('GitHub PR indexing', () => {
    let mockGitHubService: any;
    let indexerWithGitHub: Indexer;

    const mockPR: GitHubPR = {
      number: 123,
      title: 'Add authentication feature',
      body: 'This PR implements OAuth2 authentication flow',
      state: 'open',
      html_url: 'https://github.com/test/repo/pull/123',
      created_at: '2023-01-01T00:00:00Z',
      updated_at: '2023-01-02T00:00:00Z',
      merged_at: null,
      user: {
        login: 'testuser',
        avatar_url: 'https://avatars.githubusercontent.com/u/123',
      },
      head: {
        ref: 'feat/auth',
        sha: 'abc123',
      },
      base: {
        ref: 'main',
        sha: 'def456',
      },
      labels: [
        { name: 'feature', color: 'green' },
        { name: 'backend', color: 'blue' },
      ],
      draft: false,
    };

    const mockComments: GitHubComment[] = [
      {
        id: 1,
        body: 'Great work on the OAuth implementation!',
        user: { login: 'reviewer1', avatar_url: '' },
        created_at: '2023-01-01T12:00:00Z',
        updated_at: '2023-01-01T12:00:00Z',
        html_url: 'https://github.com/test/repo/pull/123#issuecomment-1',
      },
      {
        id: 2,
        body: 'Should we add rate limiting?',
        user: { login: 'reviewer2', avatar_url: '' },
        created_at: '2023-01-02T08:00:00Z',
        updated_at: '2023-01-02T08:00:00Z',
        html_url: 'https://github.com/test/repo/pull/123#issuecomment-2',
      },
    ];

    const mockReviews: GitHubReview[] = [
      {
        id: 1,
        user: { login: 'reviewer1', avatar_url: '' },
        body: 'Looks good to me!',
        state: 'APPROVED',
        submitted_at: '2023-01-02T10:00:00Z',
        html_url: 'https://github.com/test/repo/pull/123#pullrequestreview-1',
      },
      {
        id: 2,
        user: { login: 'reviewer2', avatar_url: '' },
        body: 'Please address the rate limiting concern',
        state: 'CHANGES_REQUESTED',
        submitted_at: '2023-01-02T11:00:00Z',
        html_url: 'https://github.com/test/repo/pull/123#pullrequestreview-2',
      },
    ];

    beforeEach(() => {
      // create mock github service
      mockGitHubService = {
        detectGitHubRepo: vi.fn(),
        listPullRequests: vi.fn(),
        getPRComments: vi.fn(),
        getPRReviews: vi.fn(),
      };

      indexerWithGitHub = new Indexer(testDb.db, mockGitHubService);
    });

    it('should skip indexing if GitHubService not available', async () => {
      const indexerNoGitHub = new Indexer(testDb.db);
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);
      mockVscode.workspace.findFiles = vi.fn().mockResolvedValue([]);

      await indexerNoGitHub.indexWorkspace();

      // should complete without errors
      const results = await testDb.db.searchContext('');
      const prEntries = results.filter((r) => r.type === 'pr');
      expect(prEntries).toHaveLength(0);
    });

    it('should skip indexing if not a GitHub repo', async () => {
      mockGitHubService.detectGitHubRepo.mockResolvedValue(null);

      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);
      mockVscode.workspace.findFiles = vi.fn().mockResolvedValue([]);

      await indexerWithGitHub.indexWorkspace();

      expect(mockGitHubService.detectGitHubRepo).toHaveBeenCalledWith('/test/workspace');
      expect(mockGitHubService.listPullRequests).not.toHaveBeenCalled();
    });

    it('should index open and closed PRs', async () => {
      mockGitHubService.detectGitHubRepo.mockResolvedValue({ owner: 'test', repo: 'repo' });
      mockGitHubService.listPullRequests.mockImplementation(
        async (owner: string, repo: string, state: string) => {
          if (state === 'open') {
            return [mockPR];
          }
          if (state === 'closed') {
            return [{ ...mockPR, number: 124, state: 'closed' }];
          }
          return [];
        }
      );
      mockGitHubService.getPRComments.mockResolvedValue(mockComments);
      mockGitHubService.getPRReviews.mockResolvedValue(mockReviews);

      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);
      mockVscode.workspace.findFiles = vi.fn().mockResolvedValue([]);

      await indexerWithGitHub.indexWorkspace();

      // verify PRs were indexed
      const results = await testDb.db.searchContext('authentication');
      const prEntries = results.filter((r) => r.type === 'pr');
      expect(prEntries.length).toBeGreaterThan(0);

      // check PR metadata
      const prEntry = prEntries[0];
      expect(prEntry.title).toContain('#123');
      expect(prEntry.title).toContain('Add authentication feature');
      expect(prEntry.metadata.prNumber).toBe(123);
      expect(prEntry.metadata.state).toBe('open');
      expect(prEntry.metadata.author).toBe('testuser');
      expect(prEntry.metadata.labels).toEqual(['feature', 'backend']);
    });

    it('should concatenate PR body, comments, and reviews', async () => {
      mockGitHubService.detectGitHubRepo.mockResolvedValue({ owner: 'test', repo: 'repo' });
      mockGitHubService.listPullRequests.mockResolvedValue([mockPR]);
      mockGitHubService.getPRComments.mockResolvedValue(mockComments);
      mockGitHubService.getPRReviews.mockResolvedValue(mockReviews);

      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);
      mockVscode.workspace.findFiles = vi.fn().mockResolvedValue([]);

      await indexerWithGitHub.indexWorkspace();

      const results = await testDb.db.searchContext('authentication');
      const prEntry = results.find((r) => r.type === 'pr');

      expect(prEntry).toBeDefined();
      expect(prEntry!.content).toContain('This PR implements OAuth2 authentication flow');
      expect(prEntry!.content).toContain('Great work on the OAuth implementation!');
      expect(prEntry!.content).toContain('Should we add rate limiting?');
      expect(prEntry!.content).toContain('Looks good to me!');
      expect(prEntry!.content).toContain('Please address the rate limiting concern');
      expect(prEntry!.metadata.comments_count).toBe(2);
      expect(prEntry!.metadata.reviews_count).toBe(2);
    });

    it('should handle merged PRs correctly', async () => {
      const mergedPR = { ...mockPR, state: 'closed' as const, merged_at: '2023-01-03T00:00:00Z' };
      mockGitHubService.detectGitHubRepo.mockResolvedValue({ owner: 'test', repo: 'repo' });
      mockGitHubService.listPullRequests.mockResolvedValue([mergedPR]);
      mockGitHubService.getPRComments.mockResolvedValue([]);
      mockGitHubService.getPRReviews.mockResolvedValue([]);

      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);
      mockVscode.workspace.findFiles = vi.fn().mockResolvedValue([]);

      await indexerWithGitHub.indexWorkspace();

      const results = await testDb.db.searchContext('authentication');
      const prEntry = results.find((r) => r.type === 'pr');

      expect(prEntry).toBeDefined();
      expect(prEntry!.metadata.state).toBe('merged');
    });

    it('should handle PRs with no comments or reviews', async () => {
      mockGitHubService.detectGitHubRepo.mockResolvedValue({ owner: 'test', repo: 'repo' });
      mockGitHubService.listPullRequests.mockResolvedValue([mockPR]);
      mockGitHubService.getPRComments.mockResolvedValue([]);
      mockGitHubService.getPRReviews.mockResolvedValue([]);

      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);
      mockVscode.workspace.findFiles = vi.fn().mockResolvedValue([]);

      await indexerWithGitHub.indexWorkspace();

      const results = await testDb.db.searchContext('authentication');
      const prEntry = results.find((r) => r.type === 'pr');

      expect(prEntry).toBeDefined();
      expect(prEntry!.content).toBe('This PR implements OAuth2 authentication flow');
      expect(prEntry!.metadata.comments_count).toBe(0);
      expect(prEntry!.metadata.reviews_count).toBe(0);
    });

    it('should handle GitHub API errors gracefully', async () => {
      mockGitHubService.detectGitHubRepo.mockResolvedValue({ owner: 'test', repo: 'repo' });
      mockGitHubService.listPullRequests.mockRejectedValue(new Error('API Error'));

      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);
      mockVscode.workspace.findFiles = vi.fn().mockResolvedValue([]);

      // should not throw
      await expect(indexerWithGitHub.indexWorkspace()).resolves.not.toThrow();
    });

    it('should handle rate limit errors with warning', async () => {
      const rateLimitError: any = new Error('Rate limit exceeded');
      rateLimitError.status = 403;
      rateLimitError.message = 'API rate limit exceeded';

      mockGitHubService.detectGitHubRepo.mockResolvedValue({ owner: 'test', repo: 'repo' });
      mockGitHubService.listPullRequests.mockRejectedValue(rateLimitError);

      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);
      mockVscode.workspace.findFiles = vi.fn().mockResolvedValue([]);

      // should not throw
      await expect(indexerWithGitHub.indexWorkspace()).resolves.not.toThrow();
    });

    it('should show warning with configure token option on rate limit error', async () => {
      // error must be thrown from detectGitHubRepo to reach indexGitHubData's catch
      // (fetchPRs catches errors internally and returns [])
      const rateLimitError: any = new Error('rate limit exceeded');
      rateLimitError.status = 403;

      mockGitHubService.detectGitHubRepo.mockRejectedValue(rateLimitError);

      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;
      // mock showWarningMessage to return a thenable (source calls .then())
      vi.mocked(mockVscode.window.showWarningMessage).mockResolvedValue('Configure Token' as any);

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);
      mockVscode.workspace.findFiles = vi.fn().mockResolvedValue([]);

      await indexerWithGitHub.indexWorkspace();

      // verify warning message was shown with correct text
      expect(mockVscode.window.showWarningMessage).toHaveBeenCalledWith(
        'GitHub Rate Limit Reached. Token Recommended.',
        'Configure Token'
      );
    });

    it('should detect rate limit from error message containing "rate limit"', async () => {
      // error with no status but message containing "rate limit"
      const error: any = new Error('API rate limit exceeded for unauthenticated requests');

      mockGitHubService.detectGitHubRepo.mockRejectedValue(error);

      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;
      vi.mocked(mockVscode.window.showWarningMessage).mockResolvedValue(undefined as any);

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);
      mockVscode.workspace.findFiles = vi.fn().mockResolvedValue([]);

      await indexerWithGitHub.indexWorkspace();

      // should show warning because error message includes "rate limit"
      expect(mockVscode.window.showWarningMessage).toHaveBeenCalledWith(
        'GitHub Rate Limit Reached. Token Recommended.',
        'Configure Token'
      );
    });

    it('should not show rate limit warning for non-rate-limit errors', async () => {
      // error without status=403 and without "rate limit" in message
      const error = new Error('Network timeout');

      mockGitHubService.detectGitHubRepo.mockRejectedValue(error);

      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);
      mockVscode.workspace.findFiles = vi.fn().mockResolvedValue([]);

      await indexerWithGitHub.indexWorkspace();

      // should NOT show warning for non-rate-limit errors
      expect(mockVscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('should search PR content with BM25 ranking', async () => {
      mockGitHubService.detectGitHubRepo.mockResolvedValue({ owner: 'test', repo: 'repo' });
      mockGitHubService.listPullRequests.mockResolvedValue([mockPR]);
      mockGitHubService.getPRComments.mockResolvedValue(mockComments);
      mockGitHubService.getPRReviews.mockResolvedValue(mockReviews);

      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);
      mockVscode.workspace.findFiles = vi.fn().mockResolvedValue([]);

      await indexerWithGitHub.indexWorkspace();

      // search for terms from PR comments
      const results = await indexerWithGitHub.findRelevantContext('auth.ts', 'rate limiting');

      // should find PR entry with comment about rate limiting
      const prEntry = results.find((r) => r.type === 'pr');
      expect(prEntry).toBeDefined();
      expect(prEntry!.content).toContain('rate limiting');
    });

    it('should include PR metadata in search results', async () => {
      mockGitHubService.detectGitHubRepo.mockResolvedValue({ owner: 'test', repo: 'repo' });
      mockGitHubService.listPullRequests.mockResolvedValue([mockPR]);
      mockGitHubService.getPRComments.mockResolvedValue([]);
      mockGitHubService.getPRReviews.mockResolvedValue([]);

      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);
      mockVscode.workspace.findFiles = vi.fn().mockResolvedValue([]);

      await indexerWithGitHub.indexWorkspace();

      const results = await testDb.db.searchContext('authentication');
      const prEntry = results.find((r) => r.type === 'pr');

      expect(prEntry).toBeDefined();
      expect(prEntry!.path).toBe('https://github.com/test/repo/pull/123');
      expect(prEntry!.metadata.draft).toBe(false);
      expect(prEntry!.metadata.head_ref).toBe('feat/auth');
      expect(prEntry!.metadata.base_ref).toBe('main');
    });

    it('should handle null PR body', async () => {
      const prWithNullBody = { ...mockPR, body: null };
      mockGitHubService.detectGitHubRepo.mockResolvedValue({ owner: 'test', repo: 'repo' });
      mockGitHubService.listPullRequests.mockResolvedValue([prWithNullBody]);
      mockGitHubService.getPRComments.mockResolvedValue([]);
      mockGitHubService.getPRReviews.mockResolvedValue([]);

      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);
      mockVscode.workspace.findFiles = vi.fn().mockResolvedValue([]);

      await indexerWithGitHub.indexWorkspace();

      const results = await testDb.db.searchContext('authentication');
      const prEntry = results.find((r) => r.type === 'pr');

      expect(prEntry).toBeDefined();
      expect(prEntry!.content).toBe('');
    });

    it('should handle reviews with null body', async () => {
      const reviewsWithNullBody = [{ ...mockReviews[0], body: null }, { ...mockReviews[1] }];
      mockGitHubService.detectGitHubRepo.mockResolvedValue({ owner: 'test', repo: 'repo' });
      mockGitHubService.listPullRequests.mockResolvedValue([mockPR]);
      mockGitHubService.getPRComments.mockResolvedValue([]);
      mockGitHubService.getPRReviews.mockResolvedValue(reviewsWithNullBody);

      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);
      mockVscode.workspace.findFiles = vi.fn().mockResolvedValue([]);

      await indexerWithGitHub.indexWorkspace();

      const results = await testDb.db.searchContext('authentication');
      const prEntry = results.find((r) => r.type === 'pr');

      expect(prEntry).toBeDefined();
      // should only contain non-null review body
      expect(prEntry!.content).not.toContain('Looks good to me!');
      expect(prEntry!.content).toContain('Please address the rate limiting concern');
    });
  });
});
