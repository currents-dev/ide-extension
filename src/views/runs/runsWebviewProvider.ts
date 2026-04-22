import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import type { CurrentsApiClient } from "../../api/client.js";
import type {
  RunFeedApiStatus,
  RunFeedItem,
  RunFilters,
} from "../../api/types.js";
import { SettingsWebviewProvider } from "../settings/settingsWebviewProvider.js";
import { getCodiconCss } from "../codiconCss.js";
import { log } from "../../lib/log.js";
import {
  getPrGroupKeyAndLabel,
  resolveRunTitleFromFeedItem,
} from "../../lib/runTitle.js";
import type { ApiListResponse } from "../../api/types.js";

function powershellToast(exe: string, title: string, body: string): string {
  const t = title.replace(/"/g, '\\"');
  const b = body.replace(/"/g, '\\"');
  return `${exe} -NoProfile -Command 'Add-Type -AssemblyName System.Windows.Forms; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; $n.ShowBalloonTip(5000,"${t}","${b}","Info"); Start-Sleep -Milliseconds 200; $n.Dispose()'`;
}

function sendOsNotification(title: string, body: string): void {
  let cmd: string;
  const isWsl = Boolean(process.env.WSL_DISTRO_NAME);

  switch (process.platform) {
    case "darwin": {
      const t = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const b = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      cmd = `osascript -e 'display notification "${b}" with title "${t}"'`;
      break;
    }
    case "win32":
      cmd = powershellToast("powershell", title, body);
      break;
    default:
      cmd = isWsl
        ? powershellToast("powershell.exe", title, body)
        : `notify-send '${title.replace(/'/g, "'\\''")}' '${body.replace(/'/g, "'\\''")}'`;
      break;
  }

  log(
    `[notify] sending OS notification (wsl=${isWsl}, platform=${process.platform})`,
  );
  exec(cmd, (err) => {
    if (err) {
      log("[notify] OS notification failed:", err.message);
    }
  });
}

function isRunInProgress(completionState: string): boolean {
  const v = completionState.toLowerCase();
  return v === "incomplete" || v === "in_progress";
}

export class RunsWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "currents-runs";

  private view?: vscode.WebviewView;
  private client: CurrentsApiClient | undefined;
  private projectId: string | undefined;
  private projectDisplayName: string | undefined;
  private runs: RunFeedItem[] = [];
  private hasMore = false;
  private lastCursor: string | undefined;
  private filters: RunFilters = {};
  private loading = false;
  private activeRunId: string | undefined;
  private authenticated = false;
  private autoRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private autoRefreshEnabled = true;
  private inProgressRunIds = new Set<string>();
  private groupingMode: "none" | "pr" = "none";
  private groupedLoadTargetKey: string | null = null;
  private static readonly maxGroupLoadPages = 20;
  private currentRequestToken: string | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.setAutoRefreshContext(true);
    this.setRunsGroupedByPullRequestContext();
  }

  /** Runs once on first view resolve when extension registers a handler (no saved project at startup). */
  private deferredDefaultProjectHandler: (() => Promise<void>) | undefined;
  private deferredDefaultProjectAttempted = false;

  setClient(client: CurrentsApiClient | undefined): void {
    this.client = client;
    this.authenticated = client !== undefined;
    this.sendState();
  }

  setDeferredDefaultProjectHandler(
    handler: (() => Promise<void>) | undefined,
  ): void {
    this.deferredDefaultProjectHandler = handler;
  }

  setProjectId(
    projectId: string | undefined,
    projectDisplayName?: string | undefined,
  ): void {
    const previousProjectId = this.projectId;
    this.projectId = projectId;
    if (projectId !== previousProjectId) {
      this.inProgressRunIds.clear();
    }
    if (!projectId) {
      this.projectDisplayName = undefined;
    } else if (projectDisplayName !== undefined) {
      this.projectDisplayName = projectDisplayName;
    } else if (projectId !== previousProjectId) {
      this.projectDisplayName = undefined;
    }
    this.runs = [];
    this.hasMore = false;
    this.lastCursor = undefined;
    if (projectId) {
      this.fetchRuns();
      if (this.autoRefreshEnabled) {
        this.startAutoRefresh();
      }
    } else {
      this.currentRequestToken = null;
      this.stopAutoRefresh();
      this.sendState();
    }
  }

  getFilters(): RunFilters {
    return { ...this.filters };
  }

  private hasActiveFeedFilters(filters: RunFilters = this.filters): boolean {
    return Boolean(
      filters.branches?.length ||
        filters.authors?.length ||
        filters.tags?.length ||
        filters.status?.length,
    );
  }

  private hasActiveStatusFilter(filters: RunFilters = this.filters): boolean {
    return Boolean(filters.status?.length);
  }

  private updateHasFiltersContext(filters: RunFilters): void {
    vscode.commands.executeCommand(
      "setContext",
      "currents.hasFilters",
      this.hasActiveFeedFilters(filters),
    );
  }

  setFiltersSilently(filters: RunFilters): void {
    this.filters = { ...filters };
    this.updateHasFiltersContext(filters);
  }

  setFilters(filters: RunFilters): void {
    this.filters = { ...filters };
    this.updateHasFiltersContext(filters);
    this.runs = [];
    this.hasMore = false;
    this.lastCursor = undefined;
    this.fetchRuns();
  }

  clearFilters(): void {
    this.setFilters({});
  }

  toggleGroupRunsByPullRequest(): void {
    this.groupingMode = this.groupingMode === "pr" ? "none" : "pr";
    this.setRunsGroupedByPullRequestContext();
    this.sendState();
  }

  setActiveRunId(runId: string | undefined): void {
    this.activeRunId = runId;
    if (this.view) {
      this.view.webview.postMessage({
        type: "activeRun",
        runId: runId,
      });
    }
  }

  /** Binds a single getProjectRuns request; stale responses are ignored. */
  private makeRunsRequestToken(
    requestStartingAfter: string | undefined,
  ): string {
    return JSON.stringify({
      projectId: this.projectId,
      filters: this.filters,
      groupedLoadTargetKey: this.groupedLoadTargetKey,
      requestStartingAfter: requestStartingAfter ?? null,
    });
  }

  async loadMore(): Promise<void> {
    if (!this.hasMore || this.loading) {
      return;
    }
    await this.fetchRuns(this.lastCursor);
  }

  async loadMoreForGroup(
    groupKey: string,
    groupMode: "pr",
  ): Promise<void> {
    if (groupMode !== "pr" || !this.client || !this.projectId) {
      return;
    }
    if (this.groupedLoadTargetKey !== null || this.loading) {
      return;
    }
    if (!this.hasMore) {
      return;
    }

    const keyFor = (r: RunFeedItem) => getPrGroupKeyAndLabel(r).key;
    const countBefore = this.runs.filter((r) => keyFor(r) === groupKey).length;

    this.groupedLoadTargetKey = groupKey;
    this.loading = true;
    this.sendState();

    let lastRequestToken: string | undefined;
    try {
      let pages = 0;
      while (this.hasMore && pages < RunsWebviewProvider.maxGroupLoadPages) {
        const startingAfter = this.lastCursor;
        const localToken = this.makeRunsRequestToken(startingAfter);
        lastRequestToken = localToken;
        this.currentRequestToken = localToken;
        const response = await this.client.getProjectRuns(this.projectId, {
          limit: 10,
          starting_after: startingAfter,
          ...this.filters,
        });
        if (this.currentRequestToken !== localToken) {
          break;
        }
        this.applyRunsResponse(response, startingAfter);
        pages += 1;
        const countAfter = this.runs.filter((r) => keyFor(r) === groupKey).length;
        if (countAfter > countBefore) {
          break;
        }
        this.sendState();
        if (!this.hasMore) {
          break;
        }
      }
    } catch (err) {
      if (lastRequestToken && this.currentRequestToken === lastRequestToken) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        vscode.window.showErrorMessage(`Currents: Failed to load runs. ${msg}`);
      }
    } finally {
      this.groupedLoadTargetKey = null;
      if (lastRequestToken && this.currentRequestToken === lastRequestToken) {
        this.currentRequestToken = null;
        this.loading = false;
      }
      this.sendState();
    }
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    void this.runDeferredDefaultProjectIfNeeded();

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.type) {
        case "ready":
          this.sendState();
          break;
        case "openRun": {
          const run = this.runs.find((r) => r.runId === message.runId);
          if (run) {
            vscode.commands.executeCommand("currents.openRun", run);
          }
          break;
        }
        case "loadMore":
          void this.loadMore();
          break;
        case "loadMoreForGroup": {
          if (message.groupMode === "pr" && message.groupKey != null) {
            void this.loadMoreForGroup(
              String(message.groupKey),
              "pr",
            );
          }
          break;
        }
        case "setGroupingMode": {
          const m = message.mode;
          if (m === "pr" || m === "none") {
            this.groupingMode = m;
            this.setRunsGroupedByPullRequestContext();
            this.sendState();
          }
          break;
        }
        case "openInDashboard": {
          const dashRun = this.runs.find((r) => r.runId === message.runId);
          if (dashRun) {
            vscode.commands.executeCommand("currents.openInDashboard", dashRun);
          }
          break;
        }
        case "clearFilters":
          this.clearFilters();
          break;
        case "setApiKey":
          vscode.commands.executeCommand("currents.setApiKey");
          break;
        case "selectProject":
          void vscode.commands.executeCommand("currents.selectProject");
          break;
        case "openSettings":
          void vscode.commands.executeCommand("currents.openSettingsView");
          break;
      }
    });
  }

  private async runDeferredDefaultProjectIfNeeded(): Promise<void> {
    if (this.deferredDefaultProjectAttempted || !this.deferredDefaultProjectHandler) {
      return;
    }
    this.deferredDefaultProjectAttempted = true;
    try {
      await this.deferredDefaultProjectHandler();
    } catch (err) {
      log("Currents: deferred default project selection failed:", err);
    }
  }

  private applyRunsResponse(
    response: ApiListResponse<RunFeedItem>,
    startingAfter: string | undefined,
  ): void {
    if (this.hasActiveStatusFilter()) {
      this.inProgressRunIds.clear();
    } else {
      if (!startingAfter) {
        this.detectCompletedRuns(response.data);
      }
      this.trackInProgressRuns(response.data);
    }
    this.runs.push(...response.data);
    this.hasMore = response.has_more;
    if (response.data.length > 0) {
      this.lastCursor = response.data[response.data.length - 1].cursor;
    }
  }

  private async fetchRuns(startingAfter?: string): Promise<void> {
    if (!this.client || !this.projectId) {
      return;
    }

    const localToken = this.makeRunsRequestToken(startingAfter);
    this.currentRequestToken = localToken;
    this.loading = true;
    this.sendState();

    try {
      const response = await this.client.getProjectRuns(this.projectId, {
        limit: 10,
        starting_after: startingAfter,
        ...this.filters,
      });
      if (this.currentRequestToken !== localToken) {
        return;
      }
      this.applyRunsResponse(response, startingAfter);
    } catch (err) {
      if (this.currentRequestToken === localToken) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        vscode.window.showErrorMessage(`Currents: Failed to fetch runs. ${msg}`);
      }
    } finally {
      if (this.currentRequestToken === localToken) {
        this.currentRequestToken = null;
        this.loading = false;
      }
      this.sendState();
    }
  }

  private async refreshRunsSilently(): Promise<void> {
    if (!this.client || !this.projectId) {
      return;
    }

    const localToken = this.makeRunsRequestToken(undefined);
    this.currentRequestToken = localToken;
    this.loading = true;

    try {
      const response = await this.client.getProjectRuns(this.projectId, {
        limit: 10,
        ...this.filters,
      });
      if (this.currentRequestToken !== localToken) {
        return;
      }
      this.runs = [];
      this.hasMore = false;
      this.lastCursor = undefined;
      this.applyRunsResponse(response, undefined);
    } catch (err) {
      if (this.currentRequestToken === localToken) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        vscode.window.showErrorMessage(`Currents: Failed to fetch runs. ${msg}`);
      }
    } finally {
      if (this.currentRequestToken === localToken) {
        this.currentRequestToken = null;
        this.loading = false;
      }
      this.sendState();
    }
  }

  private detectCompletedRuns(freshRuns: RunFeedItem[]): void {
    log(
      `[notify] detectCompletedRuns: tracking ${this.inProgressRunIds.size} in-progress run(s)`,
      [...this.inProgressRunIds],
    );
    if (this.inProgressRunIds.size === 0) {
      return;
    }
    for (const run of freshRuns) {
      const wasInProgress = this.inProgressRunIds.has(run.runId);
      const stillInProgress = isRunInProgress(run.completionState);
      if (wasInProgress && !stillInProgress) {
        log(
          `[notify] run ${run.runId} transitioned to "${run.completionState}" (status: ${run.status})`,
        );
        this.inProgressRunIds.delete(run.runId);
        this.notifyRunCompleted(run);
      }
    }
  }

  private trackInProgressRuns(runs: RunFeedItem[]): void {
    for (const run of runs) {
      if (isRunInProgress(run.completionState)) {
        this.inProgressRunIds.add(run.runId);
      } else {
        this.inProgressRunIds.delete(run.runId);
      }
    }
    log(
      `[notify] trackInProgressRuns: now tracking ${this.inProgressRunIds.size} in-progress run(s)`,
      [...this.inProgressRunIds],
    );
  }

  private notifyRunCompleted(run: RunFeedItem): void {
    const enabled = SettingsWebviewProvider.getNotificationsEnabled();
    log(
      `[notify] notifyRunCompleted: run=${run.runId} status=${run.status} notificationsEnabled=${enabled}`,
    );
    if (!enabled) {
      return;
    }
    const runTitle = resolveRunTitleFromFeedItem(run).slice(0, 60);
    const status = run.status.toLowerCase();
    const label =
      status === "passed"
        ? `\u2714 Run passed: ${runTitle}`
        : status === "failed"
          ? `\u2716 Run failed: ${runTitle}`
          : `Run ${status}: ${runTitle}`;

    const showFn =
      status === "failed"
        ? vscode.window.showWarningMessage
        : vscode.window.showInformationMessage;

    sendOsNotification("Currents", label);

    showFn(label, "View Details").then((action) => {
      if (action === "View Details") {
        vscode.commands.executeCommand("currents.openRun", run);
      }
    });
  }

  private sendState(): void {
    if (!this.view) {
      return;
    }
    const filterDesc = this.describeFilters();
    this.view.description = filterDesc || undefined;
    this.view.webview.postMessage({
      type: "state",
      runs: this.runs.map(serializeRun),
      hasMore: this.hasMore,
      loading: this.loading,
      filters: this.filters,
      activeRunId: this.activeRunId,
      authenticated: this.authenticated,
      projectName: this.projectId ? this.projectDisplayName ?? null : null,
      groupingMode: this.groupingMode,
      groupedLoadTargetKey: this.groupedLoadTargetKey,
    });
  }

  describeFilters(): string {
    const statusLabels: Record<RunFeedApiStatus, string> = {
      PASSED: "Passed",
      FAILED: "Failed",
      RUNNING: "Running",
      FAILING: "Failing",
    };
    const parts: string[] = [];
    if (this.filters.branches?.length) {
      parts.push(`branch: ${this.filters.branches.join(", ")}`);
    }
    if (this.filters.authors?.length) {
      parts.push(`author: ${this.filters.authors.join(", ")}`);
    }
    if (this.filters.tags?.length) {
      const op =
        this.filters.tags.length > 1
          ? ` (${this.filters.tagOperator ?? "AND"})`
          : "";
      parts.push(`tag${op}: ${this.filters.tags.join(", ")}`);
    }
    if (this.filters.status?.length) {
      parts.push(
        `status: ${this.filters.status.map((s) => statusLabels[s]).join(", ")}`,
      );
    }
    return parts.join(" | ");
  }

  setAutoRefreshEnabled(enabled: boolean): void {
    this.autoRefreshEnabled = enabled;
    this.setAutoRefreshContext(enabled);
    if (enabled && this.projectId) {
      this.startAutoRefresh();
    } else {
      this.stopAutoRefresh();
    }
  }

  private setAutoRefreshContext(enabled: boolean): void {
    vscode.commands.executeCommand(
      "setContext",
      "currents.autoRefreshEnabled",
      enabled,
    );
  }

  private setRunsGroupedByPullRequestContext(): void {
    vscode.commands.executeCommand(
      "setContext",
      "currents.runsGroupedByPullRequest",
      this.groupingMode === "pr",
    );
  }

  private startAutoRefresh(): void {
    this.stopAutoRefresh();
    this.autoRefreshTimer = setInterval(() => {
      if (this.client && this.projectId && !this.loading) {
        void this.refreshRunsSilently();
      }
    }, 30_000);
  }

  private stopAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const htmlPath = path.join(
      this.extensionUri.fsPath,
      "src",
      "views",
      "runs",
      "runs.html",
    );
    let html = fs.readFileSync(htmlPath, "utf-8");
    html = html.replace(
      "/**__CODICON_CSS__**/",
      getCodiconCss(webview, this.extensionUri),
    );
    return html;
  }
}

function serializeRun(run: RunFeedItem) {
  const { key: prGroupKey, label: prGroupLabel } = getPrGroupKeyAndLabel(run);
  const pr = run.meta.pr;
  return {
    runId: run.runId,
    status: run.status,
    completionState: run.completionState,
    createdAt: run.createdAt,
    durationMs: run.durationMs,
    displayTitle: resolveRunTitleFromFeedItem(run),
    commitMessage: run.meta.commit?.message?.split("\n")[0] || "",
    branch: run.meta.commit?.branch || "",
    authorName: run.meta.commit?.authorName || "",
    groups: run.groups,
    prGroupKey,
    prGroupLabel,
    pr:
      pr?.id != null && String(pr.id) !== ""
        ? { id: pr.id, title: pr.title ?? null }
        : null,
  };
}
