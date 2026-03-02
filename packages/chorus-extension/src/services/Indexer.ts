import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { LocalDB, ContextEntry } from '../storage/LocalDB';
import { simpleGitLog } from './GitService';
import { GitHubService } from './GitHubService';
import { GitHubPR } from '../types/github';

export class Indexer {
  constructor(
    private db: LocalDB,
    private githubService?: GitHubService
  ) {}

  async indexWorkspace(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      console.log('No workspace folders found');
      return;
    }

    console.log('Starting workspace indexing...');

    for (const folder of workspaceFolders) {
      const folderPath = folder.uri.fsPath;

      // index git commits
      await this.indexGitCommits(folderPath);

      // index documentation
      await this.indexDocuments(folderPath);

      // index github prs and issues
      await this.indexGitHubData(folderPath);
    }

    console.log('Workspace indexing completed');
  }

  private async indexGitCommits(workspacePath: string): Promise<void> {
    try {
      const commits = await simpleGitLog(workspacePath, 100); // last 100

      for (const commit of commits) {
        const filesString = commit.files.join(', ');
        const contextEntry: Omit<ContextEntry, 'id' | 'indexed_at'> = {
          type: 'commit',
          title: commit.subject,
          path: commit.hash,
          content: commit.subject + '\n\n' + commit.body + '\n\nFiles: ' + filesString,
          metadata: {
            hash: commit.hash,
            author: commit.author,
            date: commit.date,
            files: commit.files,
          },
        };

        await this.db.addContextEntry(contextEntry);
      }

      console.log('Indexed ' + commits.length + ' git commits');
    } catch (error) {
      console.error('Failed to index git commits:', error);
    }
  }

  /**
   * Indexes GitHub PR and issue data for context search.
   *
   * Fetches recent PRs (last 20 open + 10 recently closed) and indexes:
   * - PR descriptions
   * - PR comments
   * - PR reviews
   *
   * Gracefully handles GitHub unavailability or rate limiting.
   * Includes progress indication via status bar.
   *
   * @param workspacePath - The workspace folder path
   */
  private async indexGitHubData(workspacePath: string): Promise<void> {
    // skip if github service not available
    if (!this.githubService) {
      console.log('Indexer: GitHubService not available, skipping PR indexing');
      return;
    }

    try {
      // detect github repo
      const repo = await this.githubService.detectGitHubRepo(workspacePath);
      if (!repo) {
        console.log('Indexer: Not a GitHub repository, skipping PR indexing');
        return;
      }

      console.log(`Indexer: Detected GitHub repo: ${repo.owner}/${repo.repo}`);

      // show status bar progress
      vscode.window.setStatusBarMessage('$(sync~spin) Indexing GitHub PRs...', 5000);

      // fetch recent PRs (last 20 open + 10 recently closed)
      const openPRs = await this.fetchPRs(repo.owner, repo.repo, 'open', 20);
      const closedPRs = await this.fetchPRs(repo.owner, repo.repo, 'closed', 10);

      const allPRs = [...openPRs, ...closedPRs];

      if (allPRs.length === 0) {
        console.log('Indexer: No PRs found to index');
        return;
      }

      // index each PR with its comments and reviews
      let indexedCount = 0;
      for (const pr of allPRs) {
        await this.indexPR(repo.owner, repo.repo, pr);
        indexedCount++;

        // update progress periodically
        if (indexedCount % 5 === 0) {
          vscode.window.setStatusBarMessage(
            `$(sync~spin) Indexing GitHub PRs... (${indexedCount}/${allPRs.length})`,
            3000
          );
        }
      }

      console.log(`Indexed ${indexedCount} GitHub PRs`);
      vscode.window.setStatusBarMessage(`$(check) Indexed ${indexedCount} GitHub PRs`, 3000);
    } catch (error: any) {
      console.error('Indexer: Failed to index GitHub data:', error);

      // show user-friendly warning for rate limiting
      if (error?.status === 403 || error?.message?.includes('rate limit')) {
        vscode.window
          .showWarningMessage('GitHub Rate Limit Reached. Token Recommended.', 'Configure Token')
          .then((selection) => {
            if (selection === 'Configure Token') {
              vscode.commands.executeCommand('chorus.configureGitHubToken');
            }
          });
      }

      // graceful degradation: continue without GitHub data
    }
  }

  /**
   * Fetches PRs from GitHub API with pagination support.
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param state - PR state ('open' or 'closed')
   * @param limit - Maximum number of PRs to fetch
   * @returns Array of GitHub PRs
   */
  private async fetchPRs(
    owner: string,
    repo: string,
    state: 'open' | 'closed',
    limit: number
  ): Promise<GitHubPR[]> {
    if (!this.githubService) {
      return [];
    }

    try {
      const prs = await this.githubService.listPullRequests(owner, repo, state, limit);
      console.log(`Indexer: Fetched ${prs.length} ${state} PRs`);
      return prs;
    } catch (error) {
      console.error(`Indexer: Failed to fetch ${state} PRs:`, error);
      return [];
    }
  }

  /**
   * Indexes a single PR with all its comments and reviews.
   *
   * Creates a context entry with:
   * - Type: 'pr'
   * - Title: '#${number}: ${title}'
   * - Path: PR URL
   * - Content: PR body + comments + reviews (concatenated)
   * - Metadata: PR state, labels, author, dates, counts
   *
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param pr - PR data
   */
  private async indexPR(owner: string, repo: string, pr: GitHubPR): Promise<void> {
    if (!this.githubService) {
      return;
    }

    try {
      // fetch comments and reviews
      const comments = await this.githubService.getPRComments(owner, repo, pr.number);
      const reviews = await this.githubService.getPRReviews(owner, repo, pr.number);

      // concatenate all content for better search
      let content = pr.body ?? '';

      // add comments section
      if (comments.length > 0) {
        content += '\n\nComments:\n';
        for (const comment of comments) {
          content += `\n[${comment.user.login}] ${comment.body}\n`;
        }
      }

      // add reviews section
      if (reviews.length > 0) {
        content += '\n\nReviews:\n';
        for (const review of reviews) {
          if (review.body) {
            content += `\n[${review.user.login} - ${review.state}] ${review.body}\n`;
          }
        }
      }

      // determine pr state (open/closed/merged)
      const state = pr.merged_at ? 'merged' : pr.state;

      // create context entry
      const contextEntry: Omit<ContextEntry, 'id' | 'indexed_at'> = {
        type: 'pr',
        title: `#${pr.number}: ${pr.title}`,
        path: pr.html_url,
        content: content,
        metadata: {
          prNumber: pr.number,
          state: state,
          author: pr.user.login,
          labels: pr.labels.map((l) => l.name),
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          comments_count: comments.length,
          reviews_count: reviews.length,
          draft: pr.draft,
          head_ref: pr.head.ref,
          base_ref: pr.base.ref,
        },
      };

      await this.db.addContextEntry(contextEntry);
    } catch (error) {
      console.error(`Indexer: Failed to index PR ${owner}/${repo}#${pr.number}:`, error);
      // continue with other PRs
    }
  }

  private async indexDocuments(workspacePath: string): Promise<void> {
    try {
      const docPatterns = ['**/README.md', '**/docs/**/*.md', '**/*.md'];

      for (const pattern of docPatterns) {
        const files = await vscode.workspace.findFiles(
          new vscode.RelativePattern(workspacePath, pattern),
          '**/node_modules/**'
        );

        for (const file of files) {
          await this.indexMarkdownFile(file);
        }
      }

      console.log('Document indexing completed');
    } catch (error) {
      console.error('Failed to index documents:', error);
    }
  }

  private async indexMarkdownFile(fileUri: vscode.Uri): Promise<void> {
    try {
      const content = await fs.readFile(fileUri.fsPath, 'utf-8');
      const relativePath = vscode.workspace.asRelativePath(fileUri);

      // extract title from first heading or filename
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1] : path.basename(fileUri.fsPath, '.md');

      const contextEntry: Omit<ContextEntry, 'id' | 'indexed_at'> = {
        type: 'doc',
        title: title,
        path: relativePath,
        content: content,
        metadata: {
          fileSize: content.length,
          extension: path.extname(fileUri.fsPath),
        },
      };

      await this.db.addContextEntry(contextEntry);
    } catch (error) {
      console.error('Failed to index file ' + fileUri.fsPath + ':', error);
    }
  }

  async findRelevantContext(filePath: string, symbolName?: string): Promise<ContextEntry[]> {
    const queries: string[] = [];

    // add filename-based queries
    const fileName = path.basename(filePath, path.extname(filePath));
    queries.push(fileName);

    // add symbol-based queries if provided
    if (symbolName) {
      queries.push(symbolName);
    }

    // add directory-based queries
    const dirName = path.basename(path.dirname(filePath));
    queries.push(dirName);

    const allResults: ContextEntry[] = [];

    for (const query of queries) {
      const results = await this.db.searchContext(query);
      allResults.push(...results);
    }

    // deduplicate results
    const uniqueResults = this.deduplicate(allResults);

    // apply bm25 ranking
    const combinedQuery = queries.join(' ');
    const rankedResults = this.calculateBM25(combinedQuery, uniqueResults);

    return rankedResults.slice(0, 10); // top 10 results
  }

  /**
   * Removes duplicate context entries based on type and path.
   * @param entries - Array of context entries to deduplicate
   * @returns Array of unique context entries
   */
  private deduplicate(entries: ContextEntry[]): ContextEntry[] {
    const uniqueMap = new Map<string, ContextEntry>();

    // deduplicate by type:path key
    for (const entry of entries) {
      const key = entry.type + ':' + entry.path;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, entry);
      }
    }

    return Array.from(uniqueMap.values());
  }

  /**
   * Calculates bm25 relevance scores for context entries.
   * Uses standard parameters: k1=1.5, b=0.75
   *
   * bm25 formula:
   * score = sum over all query terms of:
   *   idf(term) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLength/avgDocLength))
   *
   * @param query - Search query string
   * @param entries - Context entries to rank
   * @returns Sorted array of entries (highest score first)
   */
  private calculateBM25(query: string, entries: ContextEntry[]): ContextEntry[] {
    if (entries.length === 0) {
      return [];
    }

    // tokenize query
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) {
      return entries;
    }

    // bm25 parameters
    const k1 = 1.5;
    const b = 0.75;

    // calculate average document length
    const docLengths = entries.map((entry) => this.getDocumentLength(entry));
    const avgDocLength = docLengths.reduce((sum, len) => sum + len, 0) / entries.length;

    // calculate idf for each term
    const idfMap = new Map<string, number>();
    for (const term of queryTerms) {
      idfMap.set(term, this.calculateIDF(term, entries));
    }

    // calculate bm25 score for each document
    const scoredEntries = entries.map((entry, index) => {
      let score = 0;
      const docLength = docLengths[index];

      for (const term of queryTerms) {
        const tf = this.getTermFrequency(term, entry);
        const idf = idfMap.get(term) || 0;

        // bm25 formula for single term
        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + (b * docLength) / avgDocLength);

        score += idf * (numerator / denominator);
      }

      return { entry, score };
    });

    // sort by score descending
    scoredEntries.sort((a, b) => b.score - a.score);

    return scoredEntries.map((item) => item.entry);
  }

  /**
   * Tokenizes text into lowercase terms.
   * Removes punctuation and splits on whitespace.
   * @param text - Text to tokenize
   * @returns Array of lowercase terms
   */
  private tokenize(text: string): string[] {
    // lowercase and remove punctuation
    const cleaned = text.toLowerCase().replace(/[^\w\s]/g, ' ');

    // split on whitespace and filter empty strings
    return cleaned
      .split(/\s+/)
      .filter((term) => term.length > 0)
      .filter((term) => term.length > 1); // filter single-character terms
  }

  /**
   * Calculates inverse document frequency for a term.
   * idf = log((N - df + 0.5) / (df + 0.5))
   * where N is total documents and df is documents containing term
   * @param term - Search term
   * @param documents - All documents in corpus
   * @returns IDF score
   */
  private calculateIDF(term: string, documents: ContextEntry[]): number {
    const totalDocs = documents.length;

    // count documents containing term
    let docsWithTerm = 0;
    for (const doc of documents) {
      const content = (doc.title + ' ' + doc.content).toLowerCase();
      if (content.includes(term)) {
        docsWithTerm++;
      }
    }

    // bm25 idf formula (with smoothing)
    const idf = Math.log((totalDocs - docsWithTerm + 0.5) / (docsWithTerm + 0.5) + 1.0);
    return Math.max(0, idf); // ensure non-negative
  }

  /**
   * Calculates term frequency in a document.
   * Counts occurrences of term in title and content.
   * @param term - Search term
   * @param document - Context entry to search
   * @returns Number of term occurrences
   */
  private getTermFrequency(term: string, document: ContextEntry): number {
    const content = (document.title + ' ' + document.content).toLowerCase();
    const tokens = this.tokenize(content);

    // count occurrences of term
    let count = 0;
    for (const token of tokens) {
      if (token === term) {
        count++;
      }
    }

    return count;
  }

  /**
   * Calculates document length in tokens.
   * Used for document length normalization in bm25.
   * @param document - Context entry
   * @returns Number of tokens in document
   */
  private getDocumentLength(document: ContextEntry): number {
    const content = document.title + ' ' + document.content;
    return this.tokenize(content).length;
  }
}
