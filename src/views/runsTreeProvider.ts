import * as vscode from "vscode";
import type { CurrentsApiClient } from "../api/client.js";
import type { RunFeedItem, RunFilters } from "../api/types.js";

type RunTreeItem = RunItem | LoadMoreItem | InfoItem;

export class RunsTreeProvider
  implements vscode.TreeDataProvider<RunTreeItem>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<RunTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private client: CurrentsApiClient | undefined;
  private projectId: string | undefined;
  private runs: RunFeedItem[] = [];
  private hasMore = false;
  private lastCursor: string | undefined;
  private filters: RunFilters = {};
  private loading = false;
  private autoRefreshTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.startAutoRefresh();
  }

  setClient(client: CurrentsApiClient | undefined): void {
    this.client = client;
  }

  setProjectId(projectId: string | undefined): void {
    this.projectId = projectId;
    this.reset();
  }

  getFilters(): RunFilters {
    return { ...this.filters };
  }

  setFilters(filters: RunFilters): void {
    this.filters = { ...filters };
    vscode.commands.executeCommand(
      "setContext",
      "currents.hasFilters",
      Boolean(filters.branches?.length || filters.authors?.length)
    );
    this.reset();
  }

  clearFilters(): void {
    this.setFilters({});
  }

  private reset(): void {
    this.runs = [];
    this.hasMore = false;
    this.lastCursor = undefined;
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: RunTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(
    element?: RunTreeItem
  ): Promise<RunTreeItem[]> {
    if (element) {
      return [];
    }

    if (!this.client || !this.projectId) {
      return [];
    }

    if (this.runs.length === 0 && !this.loading) {
      await this.fetchRuns();
    }

    const items: RunTreeItem[] = this.runs.map(
      (run) => new RunItem(run)
    );

    if (this.hasMore) {
      items.push(new LoadMoreItem());
    }

    if (items.length === 0 && !this.loading) {
      const filterDesc = this.describeFilters();
      items.push(
        new InfoItem(
          filterDesc
            ? `No runs found for ${filterDesc}`
            : "No runs found"
        )
      );
    }

    return items;
  }

  async loadMore(): Promise<void> {
    if (!this.hasMore || this.loading) {
      return;
    }
    await this.fetchRuns(this.lastCursor);
    this.refresh();
  }

  private async fetchRuns(startingAfter?: string): Promise<void> {
    if (!this.client || !this.projectId) {
      return;
    }

    this.loading = true;
    try {
      const response = await this.client.getProjectRuns(
        this.projectId,
        {
          limit: 10,
          starting_after: startingAfter,
          ...this.filters,
        }
      );
      this.runs.push(...response.data);
      this.hasMore = response.has_more;
      if (response.data.length > 0) {
        this.lastCursor =
          response.data[response.data.length - 1].cursor;
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Unknown error";
      vscode.window.showErrorMessage(
        `Currents: Failed to fetch runs. ${msg}`
      );
    } finally {
      this.loading = false;
    }
  }

  describeFilters(): string {
    const parts: string[] = [];
    if (this.filters.branches?.length) {
      parts.push(`branch: ${this.filters.branches.join(", ")}`);
    }
    if (this.filters.authors?.length) {
      parts.push(`author: ${this.filters.authors.join(", ")}`);
    }
    return parts.join(" | ");
  }

  private startAutoRefresh(): void {
    this.stopAutoRefresh();
    this.autoRefreshTimer = setInterval(() => {
      if (this.client && this.projectId) {
        this.reset();
      }
    }, 30_000);
  }

  private stopAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }
  }

  dispose(): void {
    this.stopAutoRefresh();
    this._onDidChangeTreeData.dispose();
  }
}

// --- Tree items ---

function isRunInProgress(completionState: string): boolean {
  const v = completionState.toLowerCase();
  return v === "incomplete" || v === "in_progress";
}

function statusThemeIcon(status: string): vscode.ThemeIcon {
  switch (status) {
    case "passed":
      return new vscode.ThemeIcon(
        "pass-filled",
        new vscode.ThemeColor("testing.iconPassed")
      );
    case "failed":
      return new vscode.ThemeIcon(
        "error",
        new vscode.ThemeColor("testing.iconFailed")
      );
    case "running":
      return new vscode.ThemeIcon(
        "sync~spin",
        new vscode.ThemeColor("testing.iconQueued")
      );
    case "cancelled":
      return new vscode.ThemeIcon(
        "circle-slash",
        new vscode.ThemeColor("disabledForeground")
      );
    case "timedout":
      return new vscode.ThemeIcon(
        "watch",
        new vscode.ThemeColor("testing.iconFailed")
      );
    default:
      return new vscode.ThemeIcon("circle-outline");
  }
}

function aggregateTests(run: RunFeedItem) {
  let passes = 0,
    failures = 0,
    skipped = 0,
    pending = 0,
    flaky = 0;
  for (const g of run.groups) {
    passes += g.tests.passes;
    failures += g.tests.failures;
    skipped += g.tests.skipped;
    pending += g.tests.pending;
    flaky += g.tests.flaky;
  }
  return { passes, failures, skipped, pending, flaky };
}

export class RunItem extends vscode.TreeItem {
  public readonly run: RunFeedItem;

  constructor(run: RunFeedItem) {
    const commitMsg =
      run.meta.commit?.message?.split("\n")[0]?.slice(0, 60) ||
      "No title";
    super(commitMsg, vscode.TreeItemCollapsibleState.None);

    this.run = run;
    this.contextValue = "run";
    this.iconPath = statusThemeIcon(run.status.toLowerCase());

    const branch = run.meta.commit?.branch || "—";
    const { passes, failures, skipped, flaky } = aggregateTests(run);
    const parts = [`\u2714 ${passes}`, `\u2716 ${failures}`, `\u25CB ${skipped}`];
    if (flaky > 0) {
      parts.push(`\u2622 ${flaky}`);
    }

    const isLive = isRunInProgress(run.completionState);
    this.description = `${branch}  \u00B7  ${parts.join("  ")}${isLive ? "  \u00B7  \u25CF live" : ""}`;

    const date = new Date(run.createdAt).toLocaleString();
    const author = run.meta.commit?.authorName || "Unknown";
    this.tooltip = new vscode.MarkdownString(
      `**${commitMsg}**\n\n` +
        `Branch: \`${branch}\`\n\n` +
        `Author: ${author}\n\n` +
        `Status: ${run.status}\n\n` +
        `Passed: ${passes} | Failed: ${failures} | Skipped: ${skipped} | Flaky: ${flaky}\n\n` +
        `Created: ${date}`
    );

    this.command = {
      command: "currents.openRun",
      title: "View Run Details",
      arguments: [run],
    };
  }
}

export class LoadMoreItem extends vscode.TreeItem {
  constructor() {
    super("Load More Runs\u2026", vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("more");
    this.command = {
      command: "currents.loadMoreRuns",
      title: "Load More",
    };
    this.contextValue = "loadMore";
  }
}

class InfoItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "info";
  }
}
