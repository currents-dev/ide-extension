import * as vscode from "vscode";
import { exec } from "child_process";
import type { CurrentsApiClient } from "../api/client.js";
import type { RunFeedItem, RunFilters } from "../api/types.js";
import { SettingsWebviewProvider } from "./settingsWebviewProvider.js";
import { log } from "../log.js";

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

  log(`[notify] sending OS notification (wsl=${isWsl}, platform=${process.platform})`);
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
  private runs: RunFeedItem[] = [];
  private hasMore = false;
  private lastCursor: string | undefined;
  private filters: RunFilters = {};
  private loading = false;
  private activeRunId: string | undefined;
  private autoRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private autoRefreshEnabled = true;
  private inProgressRunIds = new Set<string>();

  constructor(private readonly extensionUri: vscode.Uri) {
    this.setAutoRefreshContext(true);
  }

  setClient(client: CurrentsApiClient | undefined): void {
    this.client = client;
    this.sendState();
  }

  setProjectId(projectId: string | undefined): void {
    this.projectId = projectId;
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
      Boolean(filters.branches?.length || filters.authors?.length)
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
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.type) {
        case "ready":
          this.sendState();
          break;
        case "openRun": {
          const run = this.runs.find(
            (r) => r.runId === message.runId
          );
          if (run) {
            vscode.commands.executeCommand("currents.openRun", run);
          }
          break;
        }
        case "loadMore":
          this.loadMore();
          break;
        case "openInDashboard": {
          const dashRun = this.runs.find(
            (r) => r.runId === message.runId
          );
          if (dashRun) {
            vscode.commands.executeCommand(
              "currents.openInDashboard",
              dashRun
            );
          }
          break;
        }
        case "clearFilters":
          this.clearFilters();
          break;
      }
    });
  }

  private async fetchRuns(startingAfter?: string): Promise<void> {
    if (!this.client || !this.projectId) {
      return;
    }

    this.loading = true;
    this.sendState();

    try {
      const response = await this.client.getProjectRuns(
        this.projectId,
        {
          limit: 10,
          starting_after: startingAfter,
          ...this.filters,
        }
      );
      if (!startingAfter) {
        this.detectCompletedRuns(response.data);
      }
      this.runs.push(...response.data);
      this.hasMore = response.has_more;
      if (response.data.length > 0) {
        this.lastCursor =
          response.data[response.data.length - 1].cursor;
      }
      this.trackInProgressRuns(response.data);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Unknown error";
      vscode.window.showErrorMessage(
        `Currents: Failed to fetch runs. ${msg}`
      );
    } finally {
      this.loading = false;
      this.sendState();
    }
  }

  private detectCompletedRuns(freshRuns: RunFeedItem[]): void {
    log(
      `[notify] detectCompletedRuns: tracking ${this.inProgressRunIds.size} in-progress run(s)`,
      [...this.inProgressRunIds]
    );
    if (this.inProgressRunIds.size === 0) {
      return;
    }
    for (const run of freshRuns) {
      const wasInProgress = this.inProgressRunIds.has(run.runId);
      const stillInProgress = isRunInProgress(run.completionState);
      if (wasInProgress && !stillInProgress) {
        log(
          `[notify] run ${run.runId} transitioned to "${run.completionState}" (status: ${run.status})`
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
      [...this.inProgressRunIds]
    );
  }

  private notifyRunCompleted(run: RunFeedItem): void {
    const enabled = SettingsWebviewProvider.getNotificationsEnabled();
    log(
      `[notify] notifyRunCompleted: run=${run.runId} status=${run.status} notificationsEnabled=${enabled}`
    );
    if (!enabled) {
      return;
    }
    const commitMsg =
      run.meta.commit?.message?.split("\n")[0]?.slice(0, 60) || "Run";
    const status = run.status.toLowerCase();
    const label =
      status === "passed"
        ? `\u2714 Run passed: ${commitMsg}`
        : status === "failed"
          ? `\u2716 Run failed: ${commitMsg}`
          : `Run ${status}: ${commitMsg}`;

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
    });
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
      enabled
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

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
    padding: 0 8px;
  }

  .run-card {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border));
    border-radius: 6px;
    padding: 10px 12px;
    margin: 6px 0;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .run-card:hover,
  .run-card.active {
    border-color: var(--vscode-focusBorder);
  }

  .run-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .run-status {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    padding: 2px 8px;
    border-radius: 4px;
  }
  .status-passed {
    color: var(--vscode-testing-iconPassed);
    background: color-mix(in srgb, var(--vscode-testing-iconPassed) 15%, transparent);
  }
  .status-failed {
    color: var(--vscode-testing-iconFailed);
    background: color-mix(in srgb, var(--vscode-testing-iconFailed) 15%, transparent);
  }
  .status-running {
    color: var(--vscode-testing-iconQueued);
    background: color-mix(in srgb, var(--vscode-testing-iconQueued) 15%, transparent);
  }
  .status-cancelled, .status-timedout {
    color: var(--vscode-disabledForeground);
    background: color-mix(in srgb, var(--vscode-disabledForeground) 15%, transparent);
  }

  .run-duration {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .run-title {
    font-weight: 600;
    font-size: 13px;
    margin-bottom: 5px;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .run-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 8px;
  }
  .run-meta span {
    display: flex;
    align-items: center;
    gap: 3px;
  }

  .run-stats {
    display: flex;
    gap: 10px;
    font-size: 11px;
    font-weight: 500;
  }
  .stat { display: flex; align-items: center; gap: 3px; }
  .stat-passed { color: var(--vscode-testing-iconPassed); }
  .stat-failed { color: var(--vscode-testing-iconFailed); }
  .stat-skipped { color: var(--vscode-descriptionForeground); }
  .stat-flaky { color: #e57ab0; }

  .run-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border));
  }
  .action-btn {
    background: none;
    border: none;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 3px;
  }
  .action-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }

  .load-more {
    display: block;
    width: 100%;
    padding: 8px;
    margin: 8px 0 12px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-family: var(--vscode-font-family);
  }
  .load-more:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .empty-state {
    text-align: center;
    padding: 24px 12px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }

  .loading {
    text-align: center;
    padding: 24px 12px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }

  .filters-bar {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    padding: 6px 0;
    font-size: 11px;
  }
  .filter-chip {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 2px 8px;
    border-radius: 10px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .live-indicator {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: var(--vscode-testing-iconQueued);
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
</style>
</head>
<body>
  <div id="filters-bar" class="filters-bar"></div>
  <div id="runs-container"></div>
  <script>
    const vscode = acquireVsCodeApi();

    let currentState = { runs: [], hasMore: false, loading: false, filters: {}, activeRunId: null };

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'state') {
        currentState = message;
        render();
      } else if (message.type === 'activeRun') {
        currentState.activeRunId = message.runId || null;
        applyActiveState();
      }
    });

    function applyActiveState() {
      document.querySelectorAll('.run-card').forEach(card => {
        card.classList.toggle('active', card.dataset.runId === currentState.activeRunId);
      });
    }

    function formatDuration(ms) {
      if (!ms) return '';
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      const rs = s % 60;
      if (m < 60) return m + 'm ' + rs + 's';
      const h = Math.floor(m / 60);
      const rm = m % 60;
      return h + 'h ' + rm + 'm';
    }

    function timeAgo(dateStr) {
      const now = Date.now();
      const then = new Date(dateStr).getTime();
      const diff = now - then;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hours = Math.floor(mins / 60);
      if (hours < 24) return hours + 'h ago';
      const days = Math.floor(hours / 24);
      return days + 'd ago';
    }

    function aggregateTests(run) {
      let passes = 0, failures = 0, skipped = 0, pending = 0, flaky = 0;
      for (const g of run.groups) {
        passes += g.tests.passes;
        failures += g.tests.failures;
        skipped += g.tests.skipped;
        pending += g.tests.pending;
        flaky += g.tests.flaky;
      }
      return { passes, failures, skipped, pending, flaky };
    }

    function render() {
      const container = document.getElementById('runs-container');
      const filtersBar = document.getElementById('filters-bar');
      const { runs, hasMore, loading, filters } = currentState;

      // Filters
      const chips = [];
      var filterIcon = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-1px"><path d="M6 12v-1h4v1H6zM4 8v-1h8v1H4zM2 4v-1h12v1H2z"/></svg> ';
      if (filters.branches && filters.branches.length) {
        chips.push('<span class="filter-chip">' + filterIcon + escHtml(filters.branches[0]) + '</span>');
      }
      if (filters.authors && filters.authors.length) {
        chips.push('<span class="filter-chip">' + filterIcon + escHtml(filters.authors[0]) + '</span>');
      }
      filtersBar.innerHTML = chips.join('');

      if (loading && runs.length === 0) {
        container.innerHTML = '<div class="loading">Loading runs\u2026</div>';
        return;
      }

      if (runs.length === 0) {
        const hasFilters = (filters.branches && filters.branches.length) || (filters.authors && filters.authors.length);
        let emptyHtml = '<div class="empty-state">No runs found';
        if (hasFilters) {
          emptyHtml += '<br><button class="load-more" id="clear-filters-btn" style="margin-top:12px">Clear Filters</button>';
        }
        emptyHtml += '</div>';
        container.innerHTML = emptyHtml;
        if (hasFilters) {
          document.getElementById('clear-filters-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'clearFilters' });
          });
        }
        return;
      }

      let html = '';
      for (const run of runs) {
        const stats = aggregateTests(run);
        const commitMsg = (run.commitMessage || 'No title').slice(0, 70);
        const branch = run.branch || '\u2014';
        const author = run.authorName || '';
        const duration = formatDuration(run.durationMs);
        const ago = timeAgo(run.createdAt);

        const statusLower = (run.status || '').toLowerCase();
        const isLive = isRunInProgress(run.completionState);
        html += '<div class="run-card" data-run-id="' + run.runId + '">';
        html += '  <div class="run-header">';
        html += '    <span class="run-status status-' + escHtml(statusLower) + '">' + escHtml(statusLower) + '</span>';
        if (isLive) {
          html += '    <span class="live-indicator">\u25CF live</span>';
        }
        html += '    <span class="run-duration">' + (duration ? duration + ' \u00B7 ' : '') + ago + '</span>';
        html += '  </div>';
        html += '  <div class="run-title">' + escHtml(commitMsg) + '</div>';
        html += '  <div class="run-meta">';
        html += '    <span>\u2387 ' + escHtml(branch) + '</span>';
        if (author) {
          html += '    <span>\u263A ' + escHtml(author) + '</span>';
        }
        html += '  </div>';
        html += '  <div class="run-stats">';
        html += '    <span class="stat stat-passed">\u2714 ' + stats.passes + '</span>';
        html += '    <span class="stat stat-failed">\u2716 ' + stats.failures + '</span>';
        html += '    <span class="stat stat-skipped">\u25CB ' + stats.skipped + '</span>';
        if (stats.flaky > 0) {
          html += '    <span class="stat stat-flaky">\u2744 ' + stats.flaky + '</span>';
        }
        html += '  </div>';
        html += '  <div class="run-actions">';
        html += '    <button class="action-btn" data-action="dashboard" data-run-id="' + run.runId + '">\u2197 Dashboard</button>';
        html += '  </div>';
        html += '</div>';
      }

      if (hasMore) {
        html += '<button class="load-more" id="load-more-btn">' + (loading ? 'Loading\u2026' : 'Load More Runs') + '</button>';
      }

      container.innerHTML = html;

      // Attach click handlers
      document.querySelectorAll('.run-card').forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.action-btn')) return;
          vscode.postMessage({ type: 'openRun', runId: card.dataset.runId });
        });
      });

      document.querySelectorAll('.action-btn[data-action="dashboard"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'openInDashboard', runId: btn.dataset.runId });
        });
      });

      const loadMoreBtn = document.getElementById('load-more-btn');
      if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', () => {
          vscode.postMessage({ type: 'loadMore' });
        });
      }

      applyActiveState();
    }

    function isRunInProgress(completionState) {
      const v = (completionState || '').toLowerCase();
      return v === 'incomplete' || v === 'in_progress';
    }

    function escHtml(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    render();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function serializeRun(run: RunFeedItem) {
  return {
    runId: run.runId,
    status: run.status,
    completionState: run.completionState,
    createdAt: run.createdAt,
    durationMs: run.durationMs,
    commitMessage: run.meta.commit?.message?.split("\n")[0] || "",
    branch: run.meta.commit?.branch || "",
    authorName: run.meta.commit?.authorName || "",
    groups: run.groups,
  };
}
