import * as vscode from 'vscode';
import * as path from 'path';
import { LocalDB, ContextEntry } from '../storage/LocalDB';
import { Indexer } from '../services/Indexer';
import { GitHubService } from '../services/GitHubService';
import { GitHubPR, GitHubReview } from '../types/github';

export class ContextItem extends vscode.TreeItem {
  public override readonly contextValue: string;
  public readonly data?: any;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    contextValue: string = 'default',
    data?: any
  ) {
    super(label, collapsibleState);
    this.contextValue = contextValue;
    this.data = data;

    // set icon based on context value
    if (contextValue === 'commit') {
      this.iconPath = new vscode.ThemeIcon('git-commit');
    } else if (contextValue === 'doc') {
      this.iconPath = new vscode.ThemeIcon('book');
    } else if (contextValue === 'pr') {
      this.iconPath = new vscode.ThemeIcon('git-pull-request');
    } else if (contextValue === 'pr-merged') {
      this.iconPath = new vscode.ThemeIcon('git-merge');
    } else if (contextValue === 'pr-closed') {
      this.iconPath = new vscode.ThemeIcon('circle-slash');
    } else if (contextValue === 'section') {
      this.iconPath = new vscode.ThemeIcon('folder');
    } else if (contextValue === 'search') {
      this.iconPath = new vscode.ThemeIcon('search');
    }
  }
}

export class ContextTreeProvider implements vscode.TreeDataProvider<ContextItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ContextItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentFilePath: string | undefined;

  constructor(
    private db: LocalDB,
    private indexer: Indexer,
    private githubService?: GitHubService
  ) {
    // listen to active editor changes to update context
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        this.currentFilePath = editor.document.fileName;
        this.refresh();
      }
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ContextItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ContextItem): Promise<ContextItem[]> {
    if (!element) {
      // root level - show main sections
      const sections: ContextItem[] = [
        new ContextItem(
          'Current File Context',
          vscode.TreeItemCollapsibleState.Expanded,
          'section'
        ),
        new ContextItem('Active Reviews', vscode.TreeItemCollapsibleState.Expanded, 'section'),
        new ContextItem('Recent Searches', vscode.TreeItemCollapsibleState.Collapsed, 'section'),
      ];
      return sections;
    }

    // handle children for specific sections
    if (element.contextValue === 'section') {
      if (element.label === 'Current File Context') {
        return this.getCurrentFileContextItems();
      } else if (element.label === 'Active Reviews') {
        return this.getActiveReviewsItems();
      } else if (element.label === 'Recent Searches') {
        return this.getRecentSearchesItems();
      }
    } else if (element.contextValue === 'contextCategory') {
      // handle expandable categories like "Related Commits (3)"
      return this.getCategoryItems(element);
    }

    return [];
  }

  private async getCurrentFileContextItems(): Promise<ContextItem[]> {
    if (!this.currentFilePath) {
      const noFileItem = new ContextItem(
        'No file selected',
        vscode.TreeItemCollapsibleState.None,
        'empty'
      );
      return [noFileItem];
    }

    try {
      // find relevant context for current file
      const context = await this.indexer.findRelevantContext(this.currentFilePath);

      if (context.length === 0) {
        const noContextItem = new ContextItem(
          'No related context found',
          vscode.TreeItemCollapsibleState.None,
          'empty'
        );
        return [noContextItem];
      }

      // group context by type
      const commits = context.filter((c) => c.type === 'commit');
      const docs = context.filter((c) => c.type === 'doc');

      const items: ContextItem[] = [];

      // add commits category
      if (commits.length > 0) {
        const commitsCategory = new ContextItem(
          `Related Commits (${commits.length})`,
          vscode.TreeItemCollapsibleState.Expanded,
          'contextCategory',
          { type: 'commit', items: commits }
        );
        items.push(commitsCategory);
      }

      // add docs category
      if (docs.length > 0) {
        const docsCategory = new ContextItem(
          `Related Docs (${docs.length})`,
          vscode.TreeItemCollapsibleState.Expanded,
          'contextCategory',
          { type: 'doc', items: docs }
        );
        items.push(docsCategory);
      }

      // fetch pr data from context database and enrich with github api
      const prs = context.filter((c) => c.type === 'pr');

      if (prs.length > 0) {
        // enrich pr data with live status from github (if available)
        const enrichedPRs = await this.enrichPRsWithGitHubData(prs);

        const prsCategory = new ContextItem(
          `Related PRs (${prs.length})`,
          vscode.TreeItemCollapsibleState.Expanded,
          'contextCategory',
          { type: 'pr', items: enrichedPRs }
        );
        items.push(prsCategory);
      }

      return items;
    } catch (error) {
      console.error('Error getting file context:', error);
      const errorItem = new ContextItem(
        'Error loading context',
        vscode.TreeItemCollapsibleState.None,
        'error'
      );
      return [errorItem];
    }
  }

  private getCategoryItems(category: ContextItem): ContextItem[] {
    if (!category.data || !category.data.items) {
      return [];
    }

    const items: ContextItem[] = [];
    const contextEntries = category.data.items as ContextEntry[];

    for (const entry of contextEntries.slice(0, 10)) {
      // limit to 10 items
      // determine context value based on entry type and metadata
      let contextValue = entry.type;
      if (entry.type === 'pr' && entry.metadata['githubData']) {
        const prData = entry.metadata['githubData'] as GitHubPR;
        if (prData.merged_at) {
          contextValue = 'pr-merged' as any;
        } else if (prData.state === 'closed') {
          contextValue = 'pr-closed' as any;
        } else {
          contextValue = 'pr';
        }
      }

      const item = new ContextItem(
        this.formatContextItemLabel(entry),
        vscode.TreeItemCollapsibleState.None,
        contextValue,
        entry
      );

      // add description for PRs with review status
      if (entry.type === 'pr' && entry.metadata['githubData'] && entry.metadata['reviews']) {
        item.description = this.formatPRStatus(
          entry.metadata['githubData'] as GitHubPR,
          entry.metadata['reviews'] as GitHubReview[]
        );
      }

      // add tooltip
      item.tooltip = this.formatTooltip(entry);

      // add command to view context
      item.command = {
        command: 'chorus.viewContextItem',
        title: 'View Context',
        arguments: [entry],
      };

      items.push(item);
    }

    return items;
  }

  private formatContextItemLabel(entry: ContextEntry): string {
    if (entry.type === 'commit') {
      const hash = (entry.metadata['hash'] as string | undefined)?.substring(0, 7) || 'unknown';
      return `[${hash}] ${entry.title}`;
    } else if (entry.type === 'doc') {
      return path.basename(entry.path);
    } else if (entry.type === 'pr') {
      return `PR ${entry.path}: ${entry.title}`;
    }
    return entry.title;
  }

  private formatTooltip(entry: ContextEntry): string {
    if (entry.type === 'commit') {
      const author = (entry.metadata['author'] as string | undefined) || 'Unknown';
      const date = entry.metadata['date']
        ? new Date(entry.metadata['date'] as string).toLocaleDateString()
        : 'Unknown date';
      return `${entry.title}\n\nAuthor: ${author}\nDate: ${date}`;
    } else if (entry.type === 'doc') {
      return `${entry.path}\n\n${entry.content.substring(0, 200)}...`;
    } else if (entry.type === 'pr' && entry.metadata['githubData']) {
      const prData = entry.metadata['githubData'] as GitHubPR;
      const status = prData.merged_at ? 'Merged' : prData.state === 'closed' ? 'Closed' : 'Open';
      return `${entry.title}\n\nStatus: ${status}\nAuthor: ${prData.user.login}\nUpdated: ${new Date(prData.updated_at).toLocaleDateString()}`;
    }
    return entry.title;
  }

  /**
   * Formats PR status for tree item description.
   * Shows review status and comment count.
   *
   * @param prData - GitHub PR data
   * @param reviews - Array of PR reviews (optional)
   * @returns Formatted status string (e.g., "#123 • ✅ Approved • 3 comments")
   */
  private formatPRStatus(prData: GitHubPR, reviews?: GitHubReview[]): string {
    const parts: string[] = [`#${prData.number}`];

    // add review status if reviews are available
    if (reviews && reviews.length > 0) {
      const hasApproval = reviews.some((r) => r.state === 'APPROVED');
      const hasChangesRequested = reviews.some((r) => r.state === 'CHANGES_REQUESTED');

      if (hasApproval && !hasChangesRequested) {
        parts.push('✅ Approved');
      } else if (hasChangesRequested) {
        parts.push('⏳ Changes Requested');
      } else {
        parts.push('👀 Pending Review');
      }
    } else {
      parts.push('👀 Pending Review');
    }

    return parts.join(' • ');
  }

  private async getActiveReviewsItems(): Promise<ContextItem[]> {
    try {
      // fetch all PRs from context database
      const allPRs = await this.db.searchContext('', 'pr');

      if (allPRs.length === 0) {
        return [
          new ContextItem('No active reviews', vscode.TreeItemCollapsibleState.None, 'empty'),
        ];
      }

      // enrich pr data with live status from github
      const enrichedPRs = await this.enrichPRsWithGitHubData(allPRs);

      // create tree items for each PR
      const items: ContextItem[] = [];
      for (const prEntry of enrichedPRs.slice(0, 10)) {
        // limit to 10
        // determine context value based on PR state
        let contextValue = 'pr';
        if (prEntry.metadata['githubData']) {
          const prData = prEntry.metadata['githubData'] as GitHubPR;
          if (prData.merged_at) {
            contextValue = 'pr-merged' as any;
          } else if (prData.state === 'closed') {
            contextValue = 'pr-closed' as any;
          }
        }

        const item = new ContextItem(
          this.formatContextItemLabel(prEntry),
          vscode.TreeItemCollapsibleState.None,
          contextValue,
          prEntry
        );

        // add description with review status
        if (prEntry.metadata['githubData'] && prEntry.metadata['reviews']) {
          item.description = this.formatPRStatus(
            prEntry.metadata['githubData'] as GitHubPR,
            prEntry.metadata['reviews'] as GitHubReview[]
          );
        }

        // add tooltip
        item.tooltip = this.formatTooltip(prEntry);

        // add command to view PR
        item.command = {
          command: 'chorus.viewContextItem',
          title: 'View PR',
          arguments: [prEntry],
        };

        items.push(item);
      }

      return items;
    } catch (error) {
      console.error('Error getting active reviews:', error);
      return [
        new ContextItem('Error loading reviews', vscode.TreeItemCollapsibleState.None, 'error'),
      ];
    }
  }

  private async getRecentSearchesItems(): Promise<ContextItem[]> {
    try {
      // fetch recent searches from database
      const searches = await this.db.getRecentSearches(10);

      if (searches.length === 0) {
        return [
          new ContextItem('No recent searches', vscode.TreeItemCollapsibleState.None, 'empty'),
        ];
      }

      // create tree items for each search
      const items: ContextItem[] = [];
      for (const search of searches) {
        const item = new ContextItem(
          search.query,
          vscode.TreeItemCollapsibleState.None,
          'search',
          search
        );

        // add tooltip with timestamp
        const date = new Date(search.timestamp);
        item.tooltip = `Search: ${search.query}\nDate: ${date.toLocaleString()}`;

        // add command to re-execute search
        item.command = {
          command: 'chorus.executeSearch',
          title: 'Execute Search',
          arguments: [search.query],
        };

        items.push(item);
      }

      return items;
    } catch (error) {
      console.error('Error getting recent searches:', error);
      return [
        new ContextItem('Error loading searches', vscode.TreeItemCollapsibleState.None, 'error'),
      ];
    }
  }

  /**
   * Enriches PR context entries with live GitHub data (PR details and reviews).
   * Uses caching to minimize API calls.
   *
   * @param prEntries - Array of PR context entries from database
   * @returns Array of enriched PR entries with githubData and reviews in metadata
   */
  private async enrichPRsWithGitHubData(prEntries: ContextEntry[]): Promise<ContextEntry[]> {
    if (!this.githubService) {
      // no github service available, return as-is
      return prEntries;
    }

    const enriched: ContextEntry[] = [];

    for (const entry of prEntries) {
      try {
        // parse PR reference from path (format: owner/repo#number)
        const prRef = this.githubService.parsePRReference(entry.path);
        if (!prRef) {
          // invalid format, keep original entry
          enriched.push(entry);
          continue;
        }

        // fetch PR data and reviews from github (with caching)
        const [prData, reviews] = await Promise.all([
          this.githubService.getPullRequest(prRef.owner, prRef.repo, prRef.number),
          this.githubService.getPRReviews(prRef.owner, prRef.repo, prRef.number),
        ]);

        // create enriched entry with github data
        enriched.push({
          ...entry,
          metadata: {
            ...entry.metadata,
            githubData: prData,
            reviews: reviews,
          },
        });
      } catch (error) {
        console.error(`Error enriching PR ${entry.path}:`, error);
        // keep original entry on error
        enriched.push(entry);
      }
    }

    return enriched;
  }
}
