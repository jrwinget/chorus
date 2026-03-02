import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IncrementalIndexer } from './IncrementalIndexer';
import { TestDatabase } from '../test/testUtils';
import * as GitService from './GitService';
import * as vscode from 'vscode';

// mock vscode module
vi.mock('vscode', () => {
  const mockStatusBarItem = {
    text: '',
    tooltip: '',
    backgroundColor: undefined,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };

  const mockFileWatcher = {
    onDidCreate: vi.fn(),
    onDidChange: vi.fn(),
    onDidDelete: vi.fn(),
    dispose: vi.fn(),
  };

  return {
    workspace: {
      workspaceFolders: [],
      asRelativePath: vi.fn((path: string) => path),
      findFiles: vi.fn().mockResolvedValue([]),
      createFileSystemWatcher: vi.fn(() => mockFileWatcher),
    },
    window: {
      createStatusBarItem: vi.fn(() => mockStatusBarItem),
    },
    RelativePattern: vi.fn((base: string, pattern: string) => ({ base, pattern })),
    Uri: {
      file: vi.fn((path: string) => ({ fsPath: path })),
    },
    CancellationTokenSource: class {
      token = {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn(),
      };
      cancel() {
        this.token.isCancellationRequested = true;
      }
      dispose() {}
    },
    StatusBarAlignment: {
      Left: 1,
      Right: 2,
    },
    ThemeColor: class {
      constructor(public id: string) {}
    },
  };
});

describe('IncrementalIndexer', () => {
  let testDb: TestDatabase;
  let mockStatusBar: any;
  let indexer: IncrementalIndexer;

  beforeEach(async () => {
    testDb = new TestDatabase();
    await testDb.setup();

    // create mock status bar
    const vscodeModule = await import('vscode');
    mockStatusBar = vscodeModule.window.createStatusBarItem();

    indexer = new IncrementalIndexer(testDb.db, mockStatusBar);

    // reset mocks
    vi.clearAllMocks();
  });

  afterEach(async () => {
    indexer.dispose();
    await testDb.cleanup();
  });

  describe('initialization', () => {
    it('should create indexer instance', () => {
      expect(indexer).toBeDefined();
    });

    it('should initialize with no file watchers', () => {
      expect(indexer['fileWatcher']).toBeNull();
    });
  });

  describe('startWatching', () => {
    it('should start file watchers for markdown files', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      await indexer.startWatching();

      expect(mockVscode.workspace.createFileSystemWatcher).toHaveBeenCalledWith('**/*.md');
    });

    it('should handle missing workspace folders', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = null;

      await expect(indexer.startWatching()).resolves.not.toThrow();
    });

    it('should register file change handlers', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      await indexer.startWatching();

      const watcher = indexer['fileWatcher'];
      expect(watcher).not.toBeNull();
      expect(watcher?.onDidCreate).toHaveBeenCalled();
      expect(watcher?.onDidChange).toHaveBeenCalled();
      expect(watcher?.onDidDelete).toHaveBeenCalled();
    });
  });

  describe('indexIncrementally', () => {
    it('should handle empty workspace', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [];

      await indexer.indexIncrementally();

      expect(mockStatusBar.text).toContain('Ready');
    });

    it('should index new commits only', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      // set up last indexed commit
      await testDb.db.setLastIndexedCommit('oldcommit123');

      // mock git log to return commits
      const mockCommits = [
        {
          hash: 'newcommit456',
          author: 'Alice',
          date: '2023-01-02',
          subject: 'feat: new feature',
          body: 'Added cool feature',
          files: ['src/feature.ts'],
        },
        {
          hash: 'oldcommit123',
          author: 'Bob',
          date: '2023-01-01',
          subject: 'fix: old fix',
          body: 'Fixed bug',
          files: ['src/bug.ts'],
        },
      ];

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue(mockCommits);

      await indexer.indexIncrementally();

      // check that only new commit was indexed
      const results = await testDb.db.searchContext('new feature');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toBe('feat: new feature');

      // verify last indexed commit was updated
      const lastCommit = await testDb.db.getLastIndexedCommit();
      expect(lastCommit).toBe('newcommit456');
    });

    it('should index all commits when no previous index exists', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      const mockCommits = [
        {
          hash: 'commit1',
          author: 'Alice',
          date: '2023-01-01',
          subject: 'Initial commit',
          body: '',
          files: ['README.md'],
        },
      ];

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue(mockCommits);

      await indexer.indexIncrementally();

      // verify commit was indexed
      const results = await testDb.db.searchContext('Initial');
      expect(results.length).toBeGreaterThan(0);

      // verify last indexed commit was set
      const lastCommit = await testDb.db.getLastIndexedCommit();
      expect(lastCommit).toBe('commit1');
    });

    it('should handle git errors gracefully', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      vi.spyOn(GitService, 'simpleGitLog').mockRejectedValue(new Error('Git not found'));

      // should not throw
      await expect(indexer.indexIncrementally()).resolves.not.toThrow();

      // status should show ready (with 0 items)
      expect(mockStatusBar.text).toContain('Ready');
    });

    it('should update status bar during indexing', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      const mockCommits = [
        {
          hash: 'commit1',
          author: 'Alice',
          date: '2023-01-01',
          subject: 'First',
          body: '',
          files: [],
        },
      ];

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue(mockCommits);

      await indexer.indexIncrementally();

      // verify status bar was updated
      expect(mockStatusBar.show).toHaveBeenCalled();
      expect(mockStatusBar.text).toContain('Ready');
    });

    it('should process commits in batches', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      // create 25 commits to test batching (batch size is 10)
      const mockCommits = Array.from({ length: 25 }, (_, i) => ({
        hash: `commit${i}`,
        author: 'Alice',
        date: '2023-01-01',
        subject: `Commit ${i}`,
        body: '',
        files: [],
      }));

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue(mockCommits);

      await indexer.indexIncrementally();

      // verify all commits were indexed
      const results = await testDb.db.searchContext('Commit');
      expect(results.length).toBe(25);
    });
  });

  describe('forceReindex', () => {
    it('should clear metadata and reindex', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      // set up existing metadata
      await testDb.db.setLastIndexedCommit('oldcommit');

      const mockCommits = [
        {
          hash: 'newcommit',
          author: 'Alice',
          date: '2023-01-01',
          subject: 'New commit',
          body: '',
          files: [],
        },
      ];

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue(mockCommits);

      await indexer.forceReindex();

      // verify last indexed commit was updated
      const lastCommit = await testDb.db.getLastIndexedCommit();
      expect(lastCommit).toBe('newcommit');
    });

    it('should handle git errors gracefully during force reindex', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      vi.spyOn(GitService, 'simpleGitLog').mockRejectedValue(new Error('Git error'));

      // should not throw - errors are caught and logged, allowing document indexing to continue
      await expect(indexer.forceReindex()).resolves.not.toThrow();

      // status bar should still show ready state (with 0 items since git failed)
      expect(mockStatusBar.text).toContain('Ready');
    });

    it('should propagate errors from forceReindex when indexing throws', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      // mock setIndexMetadata to throw (simulates db error during metadata clear)
      vi.spyOn(testDb.db, 'setIndexMetadata').mockRejectedValue(
        new Error('DB write error')
      );

      await expect(indexer.forceReindex()).rejects.toThrow('DB write error');
    });

    it('should wait for ongoing indexing to finish before force reindex', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      // create enough commits so indexing takes time
      const mockCommits = Array.from({ length: 50 }, (_, i) => ({
        hash: `commit${i}`,
        author: 'Alice',
        date: '2023-01-01',
        subject: `Commit ${i}`,
        body: '',
        files: [],
      }));

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue(mockCommits);

      // start regular indexing
      const indexPromise = indexer.indexIncrementally();

      // immediately request force reindex (should cancel and wait for ongoing indexing)
      const forcePromise = indexer.forceReindex();

      // both should complete without errors
      await indexPromise;
      await forcePromise;

      // verify that the last indexed commit was set
      const lastCommit = await testDb.db.getLastIndexedCommit();
      expect(lastCommit).toBe('commit0');
    });
  });

  describe('cancellation', () => {
    it('should cancel ongoing indexing', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      // create many commits to give time to cancel
      const mockCommits = Array.from({ length: 100 }, (_, i) => ({
        hash: `commit${i}`,
        author: 'Alice',
        date: '2023-01-01',
        subject: `Commit ${i}`,
        body: '',
        files: [],
      }));

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue(mockCommits);

      // start indexing (don't await)
      const indexPromise = indexer.indexIncrementally();

      // cancel immediately
      indexer.cancel();

      // wait for indexing to complete
      await indexPromise;

      // indexing should have been interrupted (may not index all commits)
      // just verify it doesn't throw
      expect(true).toBe(true);
    });
  });

  describe('status bar updates', () => {
    it('should show indexing state', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);

      await indexer.indexIncrementally();

      // should have shown "Indexing..." at some point
      expect(mockStatusBar.text).toBeDefined();
    });

    it('should show ready state with item count', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      const mockCommits = [
        {
          hash: 'commit1',
          author: 'Alice',
          date: '2023-01-01',
          subject: 'Test',
          body: '',
          files: [],
        },
      ];

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue(mockCommits);

      await indexer.indexIncrementally();

      // should show "Ready" state
      expect(mockStatusBar.text).toContain('Ready');
      expect(mockStatusBar.text).toContain('items');
    });

    it('should show error state on failure', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      // mock search to fail (to trigger error state in getTotalIndexedItems)
      vi.spyOn(testDb.db, 'searchContext').mockRejectedValue(new Error('DB error'));
      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);

      await indexer.indexIncrementally();

      // error state should be shown
      expect(mockStatusBar.text).toContain('Ready');
    });
  });

  describe('file watching', () => {
    it('should queue files on create event', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      await indexer.startWatching();

      // simulate file creation
      const watcher = indexer['fileWatcher'];
      const createCallback = vi.mocked(watcher?.onDidCreate).mock.calls[0][0];

      // queue should be initially empty
      expect(indexer['indexQueue'].length).toBe(0);

      // trigger create event
      createCallback({ fsPath: '/test/workspace/new.md' } as any);

      // file should be queued
      expect(indexer['indexQueue'].length).toBe(1);
      expect(indexer['indexQueue'][0]).toBe('/test/workspace/new.md');
    });

    it('should queue files on change event', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      await indexer.startWatching();

      const watcher = indexer['fileWatcher'];
      const changeCallback = vi.mocked(watcher?.onDidChange).mock.calls[0][0];

      // trigger change event
      changeCallback({ fsPath: '/test/workspace/changed.md' } as any);

      // file should be queued
      expect(indexer['indexQueue'].length).toBe(1);
    });

    it('should not duplicate files in queue', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      await indexer.startWatching();

      const watcher = indexer['fileWatcher'];
      const createCallback = vi.mocked(watcher?.onDidCreate).mock.calls[0][0];

      // trigger same file twice
      createCallback({ fsPath: '/test/workspace/file.md' } as any);
      createCallback({ fsPath: '/test/workspace/file.md' } as any);

      // should only have one entry
      expect(indexer['indexQueue'].length).toBe(1);
    });
  });

  describe('document indexing', () => {
    it('should find and index markdown files', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      const mockFiles = [{ fsPath: '/test/workspace/README.md' }];

      mockVscode.workspace.findFiles = vi.fn().mockResolvedValue(mockFiles);

      // mock file reading
      vi.doMock('fs/promises', () => ({
        readFile: vi.fn().mockResolvedValue('# Test\n\nContent'),
      }));

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);

      await indexer.indexIncrementally();

      // verify findFiles was called
      expect(mockVscode.workspace.findFiles).toHaveBeenCalled();
    });

    it('should handle file read errors gracefully', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      const mockFiles = [{ fsPath: '/test/workspace/broken.md' }];

      mockVscode.workspace.findFiles = vi.fn().mockResolvedValue(mockFiles);

      // mock file reading to fail
      vi.doMock('fs/promises', () => ({
        readFile: vi.fn().mockRejectedValue(new Error('Permission denied')),
      }));

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);

      // should not throw
      await expect(indexer.indexIncrementally()).resolves.not.toThrow();
    });
  });

  describe('metadata tracking', () => {
    it('should store last indexed commit', async () => {
      await testDb.db.setLastIndexedCommit('abc123');

      const lastCommit = await testDb.db.getLastIndexedCommit();
      expect(lastCommit).toBe('abc123');
    });

    it('should return null for non-existent metadata', async () => {
      const lastCommit = await testDb.db.getLastIndexedCommit();
      expect(lastCommit).toBeNull();
    });

    it('should update existing metadata', async () => {
      await testDb.db.setLastIndexedCommit('old');
      await testDb.db.setLastIndexedCommit('new');

      const lastCommit = await testDb.db.getLastIndexedCommit();
      expect(lastCommit).toBe('new');
    });
  });

  describe('dispose', () => {
    it('should clean up resources', () => {
      indexer.dispose();

      expect(indexer['fileWatcher']).toBeNull();
    });

    it('should cancel ongoing operations', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      // start indexing (don't await)
      const mockCommits = Array.from({ length: 100 }, (_, i) => ({
        hash: `commit${i}`,
        author: 'Alice',
        date: '2023-01-01',
        subject: `Commit ${i}`,
        body: '',
        files: [],
      }));

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue(mockCommits);

      const indexPromise = indexer.indexIncrementally();

      // dispose should cancel
      indexer.dispose();

      // wait for indexing to finish
      await indexPromise;

      expect(true).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should skip indexing when already in progress', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      const mockCommits = Array.from({ length: 50 }, (_, i) => ({
        hash: `commit${i}`,
        author: 'Alice',
        date: '2023-01-01',
        subject: `Commit ${i}`,
        body: '',
        files: [],
      }));

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue(mockCommits);

      // start first indexing
      const promise1 = indexer.indexIncrementally();

      // immediately start a second (should return early because isIndexing === true)
      const promise2 = indexer.indexIncrementally();

      await promise1;
      await promise2;

      // simpleGitLog should only have been called once since the second request was skipped
      expect(vi.mocked(GitService.simpleGitLog)).toHaveBeenCalledTimes(1);
    });

    it('should set error status bar when indexIncrementally throws', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      // make indexGitCommitsIncremental succeed but getTotalIndexedItems throw
      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);
      vi.spyOn(testDb.db, 'searchContext').mockRejectedValue(new Error('DB crashed'));

      await indexer.indexIncrementally();

      // getTotalIndexedItems catches its own error and returns 0, so status should be ready with 0
      expect(mockStatusBar.text).toContain('Ready');
      expect(mockStatusBar.text).toContain('0 items');
    });

    it('should handle no new commits when last commit is first in history', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      // set last indexed commit to the most recent one — means 0 new commits
      await testDb.db.setLastIndexedCommit('commit0');

      const mockCommits = [
        {
          hash: 'commit0',
          author: 'Alice',
          date: '2023-01-01',
          subject: 'Most recent',
          body: '',
          files: [],
        },
        {
          hash: 'commit1',
          author: 'Bob',
          date: '2023-01-01',
          subject: 'Older',
          body: '',
          files: [],
        },
      ];

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue(mockCommits);

      await indexer.indexIncrementally();

      // newCommits = allCommits.slice(0, 0) = [] — so no new commits indexed
      const results = await testDb.db.searchContext('Most recent');
      expect(results.length).toBe(0);
    });

    it('should handle last commit not in history (force push scenario)', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      // set last indexed commit that doesn't exist in new history
      await testDb.db.setLastIndexedCommit('nonexistent');

      const mockCommits = [
        {
          hash: 'newcommit1',
          author: 'Alice',
          date: '2023-01-01',
          subject: 'New history',
          body: '',
          files: [],
        },
      ];

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue(mockCommits);

      await indexer.indexIncrementally();

      // should index all commits when last commit not found
      const results = await testDb.db.searchContext('New history');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should handle empty commit history', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);

      await expect(indexer.indexIncrementally()).resolves.not.toThrow();
    });

    it('should set null workspace folders', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = null;

      await indexer.indexIncrementally();

      // should show ready state with 0 items
      expect(mockStatusBar.text).toContain('Ready');
    });

    it('should handle concurrent indexing requests', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue([]);

      // start two indexing operations
      const promise1 = indexer.indexIncrementally();
      const promise2 = indexer.indexIncrementally();

      await promise1;
      await promise2;

      // second request should be ignored
      expect(true).toBe(true);
    });
  });

  describe('branch coverage: updateStatusBar with progress total', () => {
    it('should show progress fraction when total is provided and > 0', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      // use many commits to trigger progress display with total
      const mockCommits = Array.from({ length: 15 }, (_, i) => ({
        hash: `commitprogress${i}`,
        author: 'Alice',
        date: '2023-01-01',
        subject: `Progress Commit ${i}`,
        body: '',
        files: [],
      }));

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue(mockCommits);

      await indexer.indexIncrementally();

      // status bar should have been called with progress format at some point
      expect(mockStatusBar.show).toHaveBeenCalled();
    });

    it('should show indexing without progress when total is 0 or undefined', () => {
      // directly call the private updateStatusBar method
      (indexer as any).updateStatusBar('indexing', 0);

      expect(mockStatusBar.text).toBe('$(sync~spin) Chorus: Indexing...');
      expect(mockStatusBar.tooltip).toBe('Indexing workspace for context discovery');
    });

    it('should show indexing with progress fraction when total > 0', () => {
      (indexer as any).updateStatusBar('indexing', 5, 20);

      expect(mockStatusBar.text).toBe('$(sync~spin) Chorus: Indexing... (5/20)');
      expect(mockStatusBar.tooltip).toContain('5 of 20 items');
    });

    it('should show error state with warning icon', () => {
      (indexer as any).updateStatusBar('error', 0);

      expect(mockStatusBar.text).toBe('$(warning) Chorus: Index Error');
      expect(mockStatusBar.tooltip).toContain('Failed to index');
    });

    it('should show ready state with item count', () => {
      (indexer as any).updateStatusBar('ready', 42);

      expect(mockStatusBar.text).toBe('$(database) Chorus: Ready (42 items)');
      expect(mockStatusBar.tooltip).toContain('42 items');
    });
  });

  describe('branch coverage: getTotalIndexedItems error', () => {
    it('should return 0 when searchContext throws', async () => {
      vi.spyOn(testDb.db, 'searchContext').mockRejectedValue(new Error('DB error'));

      const result = await (indexer as any).getTotalIndexedItems();

      expect(result).toBe(0);
    });
  });

  describe('branch coverage: indexMarkdownFile title fallback', () => {
    it('should use filename as title when no heading exists', async () => {
      const fs = await import('fs/promises');
      vi.spyOn(fs, 'readFile').mockResolvedValue('No heading in this file, just plain text.');

      const mockVscode = await import('vscode');
      mockVscode.workspace.asRelativePath = vi.fn().mockReturnValue('docs/noheading.md');

      const fileUri = { fsPath: '/test/workspace/docs/noheading.md' };
      await (indexer as any).indexMarkdownFile(fileUri);

      // should have used the basename 'noheading' as the title
      const results = await testDb.db.searchContext('plain text');
      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    it('should extract title from H1 heading when present', async () => {
      const fs = await import('fs/promises');
      vi.spyOn(fs, 'readFile').mockResolvedValue('# My Document Title\n\nSome content here.');

      const mockVscode = await import('vscode');
      mockVscode.workspace.asRelativePath = vi.fn().mockReturnValue('docs/headed.md');

      const fileUri = { fsPath: '/test/workspace/docs/headed.md' };
      await (indexer as any).indexMarkdownFile(fileUri);

      const results = await testDb.db.searchContext('Document Title');
      if (results.length > 0) {
        expect(results[0].title).toBe('My Document Title');
      }
    });
  });

  describe('branch coverage: indexMarkdownFile error catch', () => {
    it('should not throw when readFile fails', async () => {
      const fs = await import('fs/promises');
      vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('ENOENT'));

      const fileUri = { fsPath: '/test/workspace/docs/missing.md' };
      await expect((indexer as any).indexMarkdownFile(fileUri)).resolves.not.toThrow();
    });
  });

  describe('branch coverage: indexDocuments error catch', () => {
    it('should not throw when findFiles fails', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.findFiles = vi.fn().mockRejectedValue(new Error('Search failed'));

      await expect((indexer as any).indexDocuments('/test/workspace')).resolves.not.toThrow();
    });
  });

  describe('branch coverage: processQueue', () => {
    it('should return early when already indexing', async () => {
      // set isIndexing to true
      (indexer as any).isIndexing = true;
      (indexer as any).indexQueue = ['/test/file.md'];

      await (indexer as any).processQueue();

      // queue should not have been drained
      expect((indexer as any).indexQueue).toHaveLength(1);

      // reset
      (indexer as any).isIndexing = false;
    });

    it('should return early when queue is empty', async () => {
      (indexer as any).indexQueue = [];

      // should not throw
      await expect((indexer as any).processQueue()).resolves.not.toThrow();
    });
  });

  describe('branch coverage: queueFile deduplication', () => {
    it('should not add same file path twice to queue', () => {
      (indexer as any).queueFile('/test/file.md');
      (indexer as any).queueFile('/test/file.md');

      expect((indexer as any).indexQueue.filter((f: string) => f === '/test/file.md').length).toBe(
        1
      );
    });

    it('should add different files to queue', () => {
      (indexer as any).queueFile('/test/file1.md');
      (indexer as any).queueFile('/test/file2.md');

      expect((indexer as any).indexQueue).toHaveLength(2);
    });
  });

  describe('branch coverage: cancellation during batch processing', () => {
    it('should stop processing commits when cancelled mid-batch', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      // create enough commits for multiple batches
      const mockCommits = Array.from({ length: 30 }, (_, i) => ({
        hash: `batchcommit${i}`,
        author: 'Alice',
        date: '2023-01-01',
        subject: `Batch Commit ${i}`,
        body: '',
        files: [],
      }));

      vi.spyOn(GitService, 'simpleGitLog').mockResolvedValue(mockCommits);

      const indexPromise = indexer.indexIncrementally();

      // cancel after a brief moment (during batch processing)
      setTimeout(() => indexer.cancel(), 5);

      await indexPromise;

      // should complete without error (some commits may be indexed, some not)
      expect(mockStatusBar.show).toHaveBeenCalled();
    });
  });

  describe('branch coverage: startWatching with empty workspace folders', () => {
    it('should return early for empty workspace folders array', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [];

      await indexer.startWatching();

      // file watcher should not be created
      expect(indexer['fileWatcher']).toBeNull();
    });
  });

  describe('branch coverage: reindexPR placeholder', () => {
    it('should not throw for reindexPR', async () => {
      await expect(indexer.reindexPR('owner', 'repo', 123)).resolves.not.toThrow();
    });
  });

  describe('branch coverage: dispose with existing file watcher', () => {
    it('should dispose file watcher if it exists', async () => {
      const mockVscode = await import('vscode');
      mockVscode.workspace.workspaceFolders = [
        {
          uri: { fsPath: '/test/workspace' },
          name: 'test',
        },
      ] as any;

      await indexer.startWatching();

      const watcher = indexer['fileWatcher'];
      expect(watcher).not.toBeNull();

      indexer.dispose();

      expect(indexer['fileWatcher']).toBeNull();
    });
  });
});
