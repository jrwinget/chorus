import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ContextTreeProvider, ContextItem } from './ContextTreeProvider';
import { LocalDB, ContextEntry } from '../storage/LocalDB';
import { Indexer } from '../services/Indexer';
import { GitHubService } from '../services/GitHubService';
import { GitHubPR, GitHubReview } from '../types/github';

// mock vscode - using explicit external to avoid bundling issues
vi.mock('vscode', () => ({
  TreeItem: class {
    public contextValue?: string;
    public iconPath?: any;
    public label: string;
    public collapsibleState: number;
    public description?: string;
    public tooltip?: string;
    public command?: any;
    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2,
  },
  EventEmitter: class {
    event = vi.fn();
    fire = vi.fn();
  },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  Range: class {
    constructor(
      public start: any,
      public end: any
    ) {}
  },
  window: {
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

describe('ContextTreeProvider', () => {
  let db: LocalDB;
  let indexer: Indexer;
  let githubService: GitHubService;
  let provider: ContextTreeProvider;

  beforeEach(() => {
    // create mock database
    db = {
      initialize: vi.fn(),
      getPRPhase: vi.fn().mockResolvedValue('blinded'),
      searchContext: vi.fn().mockResolvedValue([]),
      getRecentSearches: vi.fn().mockResolvedValue([]),
    } as any;

    // create mock indexer
    indexer = {
      findRelevantContext: vi.fn().mockResolvedValue([]),
    } as any;

    // create mock github service
    githubService = {
      parsePRReference: vi.fn(),
      getPullRequest: vi.fn(),
      getPRReviews: vi.fn(),
    } as any;

    provider = new ContextTreeProvider(db, indexer, githubService);
  });

  describe('getTreeItem', () => {
    it('should return the tree item', () => {
      const item = new ContextItem('test', vscode.TreeItemCollapsibleState.None);
      const result = provider.getTreeItem(item);
      expect(result).toBe(item);
    });
  });

  describe('getChildren', () => {
    it('should return root sections when no element provided', async () => {
      const children = await provider.getChildren();

      expect(children).toHaveLength(3);
      expect(children[0].label).toBe('Current File Context');
      expect(children[1].label).toBe('Active Reviews');
      expect(children[2].label).toBe('Recent Searches');
    });

    it('should return empty array when no file selected', async () => {
      const section = new ContextItem(
        'Current File Context',
        vscode.TreeItemCollapsibleState.Expanded,
        'section'
      );

      const children = await provider.getChildren(section);

      expect(children).toHaveLength(1);
      expect(children[0].label).toBe('No file selected');
    });

    it('should return context items when file is selected', async () => {
      // mock findRelevantContext to return some items
      const mockContext: ContextEntry[] = [
        {
          id: 1,
          type: 'commit',
          title: 'Test commit',
          path: 'abc123',
          content: 'Test content',
          metadata: { hash: 'abc123', author: 'Test Author', date: '2023-01-01' },
          indexed_at: '2023-01-01',
        },
        {
          id: 2,
          type: 'doc',
          title: 'Test doc',
          path: 'test.md',
          content: 'Test doc content',
          metadata: {},
          indexed_at: '2023-01-01',
        },
      ];

      vi.mocked(indexer.findRelevantContext).mockResolvedValue(mockContext);

      // set current file path
      (provider as any).currentFilePath = '/test/file.ts';

      const section = new ContextItem(
        'Current File Context',
        vscode.TreeItemCollapsibleState.Expanded,
        'section'
      );

      const children = await provider.getChildren(section);

      expect(children.length).toBeGreaterThan(0);
      expect(children[0].label).toContain('Related Commits');
      expect(children[1].label).toContain('Related Docs');
    });

    it('should return category items when category is expanded', async () => {
      const mockContext: ContextEntry[] = [
        {
          id: 1,
          type: 'commit',
          title: 'Test commit',
          path: 'abc123',
          content: 'Test content',
          metadata: { hash: 'abc123', author: 'Test Author', date: '2023-01-01' },
          indexed_at: '2023-01-01',
        },
      ];

      const category = new ContextItem(
        'Related Commits (1)',
        vscode.TreeItemCollapsibleState.Expanded,
        'contextCategory',
        { type: 'commit', items: mockContext }
      );

      const children = await provider.getChildren(category);

      expect(children).toHaveLength(1);
      expect(children[0].label).toContain('Test commit');
    });
  });

  describe('refresh', () => {
    it('should fire onDidChangeTreeData event', () => {
      const fireSpy = vi.spyOn((provider as any)._onDidChangeTreeData, 'fire');

      provider.refresh();

      expect(fireSpy).toHaveBeenCalledWith(undefined);
    });
  });

  describe('context item formatting', () => {
    it('should format commit items with hash and title', async () => {
      const mockContext: ContextEntry[] = [
        {
          id: 1,
          type: 'commit',
          title: 'Fix authentication bug',
          path: 'abc123def',
          content: 'Test content',
          metadata: { hash: 'abc123def', author: 'Test Author', date: '2023-01-01' },
          indexed_at: '2023-01-01',
        },
      ];

      const category = new ContextItem(
        'Related Commits (1)',
        vscode.TreeItemCollapsibleState.Expanded,
        'contextCategory',
        { type: 'commit', items: mockContext }
      );

      const children = await provider.getChildren(category);

      expect(children[0].label).toBe('[abc123d] Fix authentication bug');
    });

    it('should format doc items with filename', async () => {
      const mockContext: ContextEntry[] = [
        {
          id: 1,
          type: 'doc',
          title: 'Authentication Guide',
          path: 'docs/auth/guide.md',
          content: 'Test content',
          metadata: {},
          indexed_at: '2023-01-01',
        },
      ];

      const category = new ContextItem(
        'Related Docs (1)',
        vscode.TreeItemCollapsibleState.Expanded,
        'contextCategory',
        { type: 'doc', items: mockContext }
      );

      const children = await provider.getChildren(category);

      expect(children[0].label).toBe('guide.md');
    });
  });

  describe('PR tree items with GitHub integration', () => {
    it('should display open PR with proper icon and status', async () => {
      const mockPR: GitHubPR = {
        number: 123,
        title: 'Add new feature',
        body: 'Description',
        state: 'open',
        html_url: 'https://github.com/owner/repo/pull/123',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-02T00:00:00Z',
        merged_at: null,
        user: { login: 'testuser', avatar_url: 'https://example.com/avatar.jpg' },
        head: { ref: 'feature', sha: 'abc123' },
        base: { ref: 'main', sha: 'def456' },
        labels: [],
        draft: false,
      };

      const mockReviews: GitHubReview[] = [
        {
          id: 1,
          user: { login: 'reviewer1', avatar_url: 'https://example.com/avatar.jpg' },
          body: 'Looks good',
          state: 'APPROVED',
          submitted_at: '2023-01-02T00:00:00Z',
          html_url: 'https://github.com/owner/repo/pull/123#review-1',
        },
      ];

      const mockContext: ContextEntry[] = [
        {
          id: 1,
          type: 'pr',
          title: 'Add new feature',
          path: 'owner/repo#123',
          content: 'Description',
          metadata: {},
          indexed_at: '2023-01-01',
        },
      ];

      vi.mocked(indexer.findRelevantContext).mockResolvedValue(mockContext);
      vi.mocked(githubService.parsePRReference).mockReturnValue({
        owner: 'owner',
        repo: 'repo',
        number: 123,
      });
      vi.mocked(githubService.getPullRequest).mockResolvedValue(mockPR);
      vi.mocked(githubService.getPRReviews).mockResolvedValue(mockReviews);

      (provider as any).currentFilePath = '/test/file.ts';

      const section = new ContextItem(
        'Current File Context',
        vscode.TreeItemCollapsibleState.Expanded,
        'section'
      );

      const children = await provider.getChildren(section);
      const prCategory = children.find((c) => c.label?.toString().includes('Related PRs'));

      expect(prCategory).toBeDefined();

      const prItems = await provider.getChildren(prCategory!);

      expect(prItems).toHaveLength(1);
      expect(prItems[0].contextValue).toBe('pr');
      expect(prItems[0].label).toContain('PR owner/repo#123');
      expect(prItems[0].description).toContain('#123');
      expect(prItems[0].description).toContain('✅ Approved');
    });

    it('should display merged PR with merge icon', async () => {
      const mockPR: GitHubPR = {
        number: 456,
        title: 'Fix bug',
        body: 'Bug fix description',
        state: 'closed',
        html_url: 'https://github.com/owner/repo/pull/456',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-02T00:00:00Z',
        merged_at: '2023-01-02T00:00:00Z',
        user: { login: 'testuser', avatar_url: 'https://example.com/avatar.jpg' },
        head: { ref: 'bugfix', sha: 'abc123' },
        base: { ref: 'main', sha: 'def456' },
        labels: [],
        draft: false,
      };

      const mockContext: ContextEntry[] = [
        {
          id: 1,
          type: 'pr',
          title: 'Fix bug',
          path: 'owner/repo#456',
          content: 'Bug fix description',
          metadata: {},
          indexed_at: '2023-01-01',
        },
      ];

      vi.mocked(indexer.findRelevantContext).mockResolvedValue(mockContext);
      vi.mocked(githubService.parsePRReference).mockReturnValue({
        owner: 'owner',
        repo: 'repo',
        number: 456,
      });
      vi.mocked(githubService.getPullRequest).mockResolvedValue(mockPR);
      vi.mocked(githubService.getPRReviews).mockResolvedValue([]);

      (provider as any).currentFilePath = '/test/file.ts';

      const section = new ContextItem(
        'Current File Context',
        vscode.TreeItemCollapsibleState.Expanded,
        'section'
      );

      const children = await provider.getChildren(section);
      const prCategory = children.find((c) => c.label?.toString().includes('Related PRs'));
      const prItems = await provider.getChildren(prCategory!);

      expect(prItems[0].contextValue).toBe('pr-merged');
    });

    it('should display closed PR with closed icon', async () => {
      const mockPR: GitHubPR = {
        number: 789,
        title: 'Experimental feature',
        body: 'Not merged',
        state: 'closed',
        html_url: 'https://github.com/owner/repo/pull/789',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-02T00:00:00Z',
        merged_at: null,
        user: { login: 'testuser', avatar_url: 'https://example.com/avatar.jpg' },
        head: { ref: 'experiment', sha: 'abc123' },
        base: { ref: 'main', sha: 'def456' },
        labels: [],
        draft: false,
      };

      const mockContext: ContextEntry[] = [
        {
          id: 1,
          type: 'pr',
          title: 'Experimental feature',
          path: 'owner/repo#789',
          content: 'Not merged',
          metadata: {},
          indexed_at: '2023-01-01',
        },
      ];

      vi.mocked(indexer.findRelevantContext).mockResolvedValue(mockContext);
      vi.mocked(githubService.parsePRReference).mockReturnValue({
        owner: 'owner',
        repo: 'repo',
        number: 789,
      });
      vi.mocked(githubService.getPullRequest).mockResolvedValue(mockPR);
      vi.mocked(githubService.getPRReviews).mockResolvedValue([]);

      (provider as any).currentFilePath = '/test/file.ts';

      const section = new ContextItem(
        'Current File Context',
        vscode.TreeItemCollapsibleState.Expanded,
        'section'
      );

      const children = await provider.getChildren(section);
      const prCategory = children.find((c) => c.label?.toString().includes('Related PRs'));
      const prItems = await provider.getChildren(prCategory!);

      expect(prItems[0].contextValue).toBe('pr-closed');
    });

    it('should show changes requested status', async () => {
      const mockPR: GitHubPR = {
        number: 111,
        title: 'Needs changes',
        body: 'Description',
        state: 'open',
        html_url: 'https://github.com/owner/repo/pull/111',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-02T00:00:00Z',
        merged_at: null,
        user: { login: 'testuser', avatar_url: 'https://example.com/avatar.jpg' },
        head: { ref: 'feature', sha: 'abc123' },
        base: { ref: 'main', sha: 'def456' },
        labels: [],
        draft: false,
      };

      const mockReviews: GitHubReview[] = [
        {
          id: 1,
          user: { login: 'reviewer1', avatar_url: 'https://example.com/avatar.jpg' },
          body: 'Please fix this',
          state: 'CHANGES_REQUESTED',
          submitted_at: '2023-01-02T00:00:00Z',
          html_url: 'https://github.com/owner/repo/pull/111#review-1',
        },
      ];

      const mockContext: ContextEntry[] = [
        {
          id: 1,
          type: 'pr',
          title: 'Needs changes',
          path: 'owner/repo#111',
          content: 'Description',
          metadata: {},
          indexed_at: '2023-01-01',
        },
      ];

      vi.mocked(indexer.findRelevantContext).mockResolvedValue(mockContext);
      vi.mocked(githubService.parsePRReference).mockReturnValue({
        owner: 'owner',
        repo: 'repo',
        number: 111,
      });
      vi.mocked(githubService.getPullRequest).mockResolvedValue(mockPR);
      vi.mocked(githubService.getPRReviews).mockResolvedValue(mockReviews);

      (provider as any).currentFilePath = '/test/file.ts';

      const section = new ContextItem(
        'Current File Context',
        vscode.TreeItemCollapsibleState.Expanded,
        'section'
      );

      const children = await provider.getChildren(section);
      const prCategory = children.find((c) => c.label?.toString().includes('Related PRs'));
      const prItems = await provider.getChildren(prCategory!);

      expect(prItems[0].description).toContain('⏳ Changes Requested');
    });
  });

  describe('enrichPRsWithGitHubData edge cases', () => {
    it('should return PRs as-is when no github service is available', async () => {
      // create provider without github service
      const providerNoGithub = new ContextTreeProvider(db, indexer);

      const mockContext: ContextEntry[] = [
        {
          id: 1,
          type: 'pr',
          title: 'Test PR',
          path: 'owner/repo#100',
          content: 'Description',
          metadata: {},
          indexed_at: '2023-01-01',
        },
      ];

      vi.mocked(db.searchContext).mockResolvedValue(mockContext);

      const section = new ContextItem(
        'Active Reviews',
        vscode.TreeItemCollapsibleState.Expanded,
        'section'
      );

      const children = await providerNoGithub.getChildren(section);

      // should still show the PR without enrichment
      expect(children.length).toBeGreaterThan(0);
      expect(children[0].label).toContain('PR owner/repo#100');
    });

    it('should handle invalid PR reference gracefully during enrichment', async () => {
      const mockContext: ContextEntry[] = [
        {
          id: 1,
          type: 'pr',
          title: 'Bad PR',
          path: 'invalid-format',
          content: 'Description',
          metadata: {},
          indexed_at: '2023-01-01',
        },
      ];

      vi.mocked(db.searchContext).mockResolvedValue(mockContext);
      vi.mocked(githubService.parsePRReference).mockReturnValue(null);

      const section = new ContextItem(
        'Active Reviews',
        vscode.TreeItemCollapsibleState.Expanded,
        'section'
      );

      const children = await provider.getChildren(section);

      // should still show the entry (original, unenriched)
      expect(children.length).toBeGreaterThan(0);
    });

    it('should keep original entry on github api error during enrichment', async () => {
      const mockContext: ContextEntry[] = [
        {
          id: 1,
          type: 'pr',
          title: 'Error PR',
          path: 'owner/repo#200',
          content: 'Description',
          metadata: {},
          indexed_at: '2023-01-01',
        },
      ];

      vi.mocked(db.searchContext).mockResolvedValue(mockContext);
      vi.mocked(githubService.parsePRReference).mockReturnValue({
        owner: 'owner',
        repo: 'repo',
        number: 200,
      });
      vi.mocked(githubService.getPullRequest).mockRejectedValue(new Error('API error'));

      const section = new ContextItem(
        'Active Reviews',
        vscode.TreeItemCollapsibleState.Expanded,
        'section'
      );

      const children = await provider.getChildren(section);

      // should show the original entry despite API error
      expect(children.length).toBeGreaterThan(0);
      expect(children[0].label).toContain('PR owner/repo#200');
    });
  });

  describe('error handling in sections', () => {
    it('should return error item when getRecentSearches throws', async () => {
      vi.mocked(db.getRecentSearches).mockRejectedValue(new Error('DB error'));

      const section = new ContextItem(
        'Recent Searches',
        vscode.TreeItemCollapsibleState.Expanded,
        'section'
      );

      const children = await provider.getChildren(section);

      expect(children).toHaveLength(1);
      expect(children[0].label).toBe('Error loading searches');
      expect(children[0].contextValue).toBe('error');
    });

    it('should return error item when active reviews search throws', async () => {
      vi.mocked(db.searchContext).mockRejectedValue(new Error('DB error'));

      const section = new ContextItem(
        'Active Reviews',
        vscode.TreeItemCollapsibleState.Expanded,
        'section'
      );

      const children = await provider.getChildren(section);

      expect(children).toHaveLength(1);
      expect(children[0].label).toBe('Error loading reviews');
      expect(children[0].contextValue).toBe('error');
    });

    it('should return error item when file context loading throws', async () => {
      vi.mocked(indexer.findRelevantContext).mockRejectedValue(new Error('Indexer error'));
      (provider as any).currentFilePath = '/test/file.ts';

      const section = new ContextItem(
        'Current File Context',
        vscode.TreeItemCollapsibleState.Expanded,
        'section'
      );

      const children = await provider.getChildren(section);

      expect(children).toHaveLength(1);
      expect(children[0].label).toBe('Error loading context');
      expect(children[0].contextValue).toBe('error');
    });

    it('should return empty array for unknown section', async () => {
      const section = new ContextItem(
        'Unknown Section',
        vscode.TreeItemCollapsibleState.Expanded,
        'section'
      );

      const children = await provider.getChildren(section);

      expect(children).toHaveLength(0);
    });
  });

  describe('Active Reviews section', () => {
    it('should display PRs from database in active reviews', async () => {
      const mockPRs: ContextEntry[] = [
        {
          id: 1,
          type: 'pr',
          title: 'Active PR 1',
          path: 'owner/repo#100',
          content: 'Description',
          metadata: {},
          indexed_at: '2023-01-01',
        },
      ];

      vi.mocked(db.searchContext).mockResolvedValue(mockPRs);

      const section = new ContextItem(
        'Active Reviews',
        vscode.TreeItemCollapsibleState.Expanded,
        'section'
      );

      const children = await provider.getChildren(section);

      expect(children.length).toBeGreaterThan(0);
      expect(children[0].label).toContain('PR owner/repo#100');
    });

    it('should show no active reviews when database is empty', async () => {
      vi.mocked(db.searchContext).mockResolvedValue([]);

      const section = new ContextItem(
        'Active Reviews',
        vscode.TreeItemCollapsibleState.Expanded,
        'section'
      );

      const children = await provider.getChildren(section);

      expect(children).toHaveLength(1);
      expect(children[0].label).toBe('No active reviews');
    });
  });

  describe('Recent Searches section', () => {
    it('should display recent searches from database', async () => {
      const mockSearches = [
        { id: 1, query: 'authentication', timestamp: '2023-01-01T00:00:00Z' },
        { id: 2, query: 'database', timestamp: '2023-01-02T00:00:00Z' },
      ];

      vi.mocked(db.getRecentSearches).mockResolvedValue(mockSearches);

      const section = new ContextItem(
        'Recent Searches',
        vscode.TreeItemCollapsibleState.Expanded,
        'section'
      );

      const children = await provider.getChildren(section);

      expect(children).toHaveLength(2);
      expect(children[0].label).toBe('authentication');
      expect(children[1].label).toBe('database');
      expect(children[0].contextValue).toBe('search');
    });

    it('should show no recent searches when database is empty', async () => {
      vi.mocked(db.getRecentSearches).mockResolvedValue([]);

      const section = new ContextItem(
        'Recent Searches',
        vscode.TreeItemCollapsibleState.Expanded,
        'section'
      );

      const children = await provider.getChildren(section);

      expect(children).toHaveLength(1);
      expect(children[0].label).toBe('No recent searches');
    });

    it('should add command to re-execute search', async () => {
      const mockSearches = [{ id: 1, query: 'test query', timestamp: '2023-01-01T00:00:00Z' }];

      vi.mocked(db.getRecentSearches).mockResolvedValue(mockSearches);

      const section = new ContextItem(
        'Recent Searches',
        vscode.TreeItemCollapsibleState.Expanded,
        'section'
      );

      const children = await provider.getChildren(section);

      expect(children[0].command).toBeDefined();
      expect(children[0].command.command).toBe('chorus.executeSearch');
      expect(children[0].command.arguments).toEqual(['test query']);
    });
  });
});
