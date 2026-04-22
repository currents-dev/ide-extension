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
import { resolveRunTitleFromFeedItem } from "../../lib/runTitle.js";
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

  constructor(private readonly extensionUri: vscode.Uri) {
    this.setAutoRefreshContext(true);
  }

  setClient(client: CurrentsApiClient | undefined): void {
    this.client = client;
    this.authenticated = client !== undefined;
    this.sendState();
  }

  setProjectId(
    projectId: string | undefined,
    projectDisplayName?: string | undefined,
  ): void {
    this.projectId = projectId;
    if (!projectId) {
      this.projectDisplayName = undefined;
    } else if (projectDisplayName !== undefined) {
      this.projectDisplayName = projectDisplayName;
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
      this.stopAutoRefresh();
      this.sendState();
    }
  }

  getFilters(): RunFilters {
    return { ...this.filters };
  }

  setFilters(filters: RunFilters): void {
    this.filters = { ...filters };
    vscode.commands.executeCommand(
      "setContext",
      "currents.hasFilters",
      Boolean(
        filters.branches?.length ||
          filters.authors?.length ||
          filters.tags?.length ||
          filters.status?.length,
      ),
    );
    this.runs = [];
    this.hasMore = false;
    this.lastCursor = undefined;
    this.fetchRuns();
  }

  clearFilters(): void {
    this.setFilters({});
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

  async loadMore(): Promise<void> {
    if (!this.hasMore || this.loading) {
      return;
    }
    await this.fetchRuns(this.lastCursor);
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
        case "openSettings":
          void vscode.commands.executeCommand("currents.openSettingsView");
          break;
      }
    });
  }

  private applyRunsResponse(
    response: ApiListResponse<RunFeedItem>,
    startingAfter: string | undefined,
  ): void {
    if (!startingAfter) {
      this.detectCompletedRuns(response.data);
    }
    this.runs.push(...response.data);
    this.hasMore = response.has_more;
    if (response.data.length > 0) {
      this.lastCursor = response.data[response.data.length - 1].cursor;
    }
    this.trackInProgressRuns(response.data);
  }

  private async fetchRuns(startingAfter?: string): Promise<void> {
    if (!this.client || !this.projectId) {
      return;
    }

    this.loading = true;
    this.sendState();

    try {
      const response = await this.client.getProjectRuns(this.projectId, {
        limit: 10,
        starting_after: startingAfter,
        ...this.filters,
      });
      this.applyRunsResponse(response, startingAfter);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      vscode.window.showErrorMessage(`Currents: Failed to fetch runs. ${msg}`);
    } finally {
      this.loading = false;
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

  private startAutoRefresh(): void {
    this.stopAutoRefresh();
    this.autoRefreshTimer = setInterval(() => {
      if (this.client && this.projectId && !this.loading) {
        this.runs = [];
        this.hasMore = false;
        this.lastCursor = undefined;
        this.fetchRuns();
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
  };
}
