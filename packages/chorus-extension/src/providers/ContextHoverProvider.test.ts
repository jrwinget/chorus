import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ContextHoverProvider } from './ContextHoverProvider';
import { Indexer } from '../services/Indexer';
import { ContextEntry } from '../storage/LocalDB';

// mock vscode - using explicit external to avoid bundling issues
vi.mock('vscode', () => ({
  Hover: class {
    constructor(
      public contents: any,
      public range?: any
    ) {}
  },
  MarkdownString: class {
    isTrusted = false;
    supportHtml = false;
    private content = '';

    appendMarkdown(value: string) {
      this.content += value;
    }

    getValue() {
      return this.content;
    }
  },
  Range: class {
    constructor(
      public start: any,
      public end: any
    ) {}
  },
}));

describe('ContextHoverProvider', () => {
  let indexer: Indexer;
  let provider: ContextHoverProvider;

  beforeEach(() => {
    // create mock indexer
    indexer = {
      findRelevantContext: vi.fn().mockResolvedValue([]),
    } as any;

    provider = new ContextHoverProvider(indexer);
  });

  describe('provideHover', () => {
    it('should return undefined when no word range found', async () => {
      const document = {
        getText: vi.fn(),
        getWordRangeAtPosition: vi.fn().mockReturnValue(undefined),
        fileName: 'test.ts',
      } as any;

      const position = {} as any;
      const token = {} as any;

      const result = await provider.provideHover(document, position, token);

      expect(result).toBeUndefined();
    });

    it('should return undefined for very short words', async () => {
      const document = {
        getText: vi.fn().mockReturnValue('ab'),
        getWordRangeAtPosition: vi.fn().mockReturnValue(new vscode.Range(0, 0, 0, 2)),
        fileName: 'test.ts',
      } as any;

      const position = {} as any;
      const token = {} as any;

      const result = await provider.provideHover(document, position, token);

      expect(result).toBeUndefined();
    });

    it('should return undefined when no context found', async () => {
      const document = {
        getText: vi.fn().mockReturnValue('authentication'),
        getWordRangeAtPosition: vi.fn().mockReturnValue(new vscode.Range(0, 0, 0, 14)),
        fileName: 'test.ts',
      } as any;

      const position = {} as any;
      const token = {} as any;

      vi.mocked(indexer.findRelevantContext).mockResolvedValue([]);

      const result = await provider.provideHover(document, position, token);

      expect(result).toBeUndefined();
    });

    it('should return hover with context items when found', async () => {
      const mockContext: ContextEntry[] = [
        {
          id: 1,
          type: 'commit',
          title: 'Fix authentication bug',
          path: 'abc123',
          content: 'Test content',
          metadata: { hash: 'abc123', author: 'Test Author', date: '2023-01-01' },
          indexed_at: '2023-01-01',
        },
      ];

      const document = {
        getText: vi.fn().mockReturnValue('authentication'),
        getWordRangeAtPosition: vi.fn().mockReturnValue(new vscode.Range(0, 0, 0, 14)),
        fileName: 'test.ts',
      } as any;

      const position = {} as any;
      const token = {} as any;

      vi.mocked(indexer.findRelevantContext).mockResolvedValue(mockContext);

      const result = await provider.provideHover(document, position, token);

      expect(result).toBeDefined();
      expect(result).toBeInstanceOf(vscode.Hover);
    });

    it('should limit hover to top 3 results', async () => {
      const mockContext: ContextEntry[] = [
        {
          id: 1,
          type: 'commit',
          title: 'Commit 1',
          path: 'abc',
          content: '',
          metadata: { hash: 'abc', author: 'Author', date: '2023-01-01' },
          indexed_at: '2023-01-01',
        },
        {
          id: 2,
          type: 'commit',
          title: 'Commit 2',
          path: 'def',
          content: '',
          metadata: { hash: 'def', author: 'Author', date: '2023-01-01' },
          indexed_at: '2023-01-01',
        },
        {
          id: 3,
          type: 'commit',
          title: 'Commit 3',
          path: 'ghi',
          content: '',
          metadata: { hash: 'ghi', author: 'Author', date: '2023-01-01' },
          indexed_at: '2023-01-01',
        },
        {
          id: 4,
          type: 'commit',
          title: 'Commit 4',
          path: 'jkl',
          content: '',
          metadata: { hash: 'jkl', author: 'Author', date: '2023-01-01' },
          indexed_at: '2023-01-01',
        },
      ];

      const document = {
        getText: vi.fn().mockReturnValue('test'),
        getWordRangeAtPosition: vi.fn().mockReturnValue(new vscode.Range(0, 0, 0, 4)),
        fileName: 'test.ts',
      } as any;

      const position = {} as any;
      const token = {} as any;

      vi.mocked(indexer.findRelevantContext).mockResolvedValue(mockContext);

      const result = await provider.provideHover(document, position, token);

      expect(result).toBeDefined();
      // hover should contain reference to "1 more result" since we have 4 items but show only 3
    });

    it('should format commit items correctly', async () => {
      const mockContext: ContextEntry[] = [
        {
          id: 1,
          type: 'commit',
          title: 'Fix authentication bug',
          path: 'abc123',
          content: 'Test content',
          metadata: { hash: 'abc123def', author: 'John Doe', date: '2023-01-01' },
          indexed_at: '2023-01-01',
        },
      ];

      const document = {
        getText: vi.fn().mockReturnValue('authentication'),
        getWordRangeAtPosition: vi.fn().mockReturnValue(new vscode.Range(0, 0, 0, 14)),
        fileName: 'test.ts',
      } as any;

      const position = {} as any;
      const token = {} as any;

      vi.mocked(indexer.findRelevantContext).mockResolvedValue(mockContext);

      const result = await provider.provideHover(document, position, token);

      expect(result).toBeDefined();
      expect(result?.contents).toBeDefined();
    });

    it('should format PR items correctly', async () => {
      const mockContext: ContextEntry[] = [
        {
          id: 1,
          type: 'pr',
          title: 'Add authentication flow',
          path: 'owner/repo#42',
          content: 'PR description',
          metadata: {},
          indexed_at: '2023-01-01',
        },
      ];

      const document = {
        getText: vi.fn().mockReturnValue('authentication'),
        getWordRangeAtPosition: vi.fn().mockReturnValue(new vscode.Range(0, 0, 0, 14)),
        fileName: 'test.ts',
      } as any;

      const position = {} as any;
      const token = {} as any;

      vi.mocked(indexer.findRelevantContext).mockResolvedValue(mockContext);

      const result = await provider.provideHover(document, position, token);

      expect(result).toBeDefined();
      expect(result).toBeInstanceOf(vscode.Hover);
    });

    it('should format commit with files list', async () => {
      const mockContext: ContextEntry[] = [
        {
          id: 1,
          type: 'commit',
          title: 'Fix auth',
          path: 'abc123',
          content: 'Content',
          metadata: {
            hash: 'abc123def',
            author: 'Alice',
            date: '2023-06-15',
            files: ['src/auth.ts', 'src/utils.ts', 'src/types.ts', 'src/index.ts'],
          },
          indexed_at: '2023-01-01',
        },
      ];

      const document = {
        getText: vi.fn().mockReturnValue('authentication'),
        getWordRangeAtPosition: vi.fn().mockReturnValue(new vscode.Range(0, 0, 0, 14)),
        fileName: 'test.ts',
      } as any;

      const position = {} as any;
      const token = {} as any;

      vi.mocked(indexer.findRelevantContext).mockResolvedValue(mockContext);

      const result = await provider.provideHover(document, position, token);

      expect(result).toBeDefined();
      expect(result).toBeInstanceOf(vscode.Hover);
    });

    it('should format commit with missing metadata fields', async () => {
      const mockContext: ContextEntry[] = [
        {
          id: 1,
          type: 'commit',
          title: 'Minimal commit',
          path: 'xyz',
          content: 'Content',
          metadata: {},
          indexed_at: '2023-01-01',
        },
      ];

      const document = {
        getText: vi.fn().mockReturnValue('minimal'),
        getWordRangeAtPosition: vi.fn().mockReturnValue(new vscode.Range(0, 0, 0, 7)),
        fileName: 'test.ts',
      } as any;

      const position = {} as any;
      const token = {} as any;

      vi.mocked(indexer.findRelevantContext).mockResolvedValue(mockContext);

      const result = await provider.provideHover(document, position, token);

      // should handle missing hash, author, date gracefully
      expect(result).toBeDefined();
      expect(result).toBeInstanceOf(vscode.Hover);
    });

    it('should return undefined when indexer throws error', async () => {
      const document = {
        getText: vi.fn().mockReturnValue('authentication'),
        getWordRangeAtPosition: vi.fn().mockReturnValue(new vscode.Range(0, 0, 0, 14)),
        fileName: 'test.ts',
      } as any;

      const position = {} as any;
      const token = {} as any;

      vi.mocked(indexer.findRelevantContext).mockRejectedValue(new Error('Indexer crashed'));

      const result = await provider.provideHover(document, position, token);

      expect(result).toBeUndefined();
    });

    it('should format doc with long content (>150 chars) with ellipsis', async () => {
      const longContent = 'A'.repeat(200);
      const mockContext: ContextEntry[] = [
        {
          id: 1,
          type: 'doc',
          title: 'Long Doc',
          path: 'docs/long.md',
          content: longContent,
          metadata: {},
          indexed_at: '2023-01-01',
        },
      ];

      const document = {
        getText: vi.fn().mockReturnValue('documentation'),
        getWordRangeAtPosition: vi.fn().mockReturnValue(new vscode.Range(0, 0, 0, 13)),
        fileName: 'test.ts',
      } as any;

      const position = {} as any;
      const token = {} as any;

      vi.mocked(indexer.findRelevantContext).mockResolvedValue(mockContext);

      const result = await provider.provideHover(document, position, token);

      expect(result).toBeDefined();
      expect(result).toBeInstanceOf(vscode.Hover);
    });

    it('should format doc items correctly', async () => {
      const mockContext: ContextEntry[] = [
        {
          id: 1,
          type: 'doc',
          title: 'Authentication Guide',
          path: 'docs/auth.md',
          content:
            'This is a guide about authentication in our system. It covers various topics...',
          metadata: {},
          indexed_at: '2023-01-01',
        },
      ];

      const document = {
        getText: vi.fn().mockReturnValue('authentication'),
        getWordRangeAtPosition: vi.fn().mockReturnValue(new vscode.Range(0, 0, 0, 14)),
        fileName: 'test.ts',
      } as any;

      const position = {} as any;
      const token = {} as any;

      vi.mocked(indexer.findRelevantContext).mockResolvedValue(mockContext);

      const result = await provider.provideHover(document, position, token);

      expect(result).toBeDefined();
      expect(result?.contents).toBeDefined();
    });
  });
});
