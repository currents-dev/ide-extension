import * as vscode from "vscode";
import type { CurrentsApiClient } from "../api/client.js";
import type { TestExplorerItem } from "../api/types.js";
import { log } from "../log.js";

type DateRange = "14d" | "30d" | "60d" | "90d";
type SortMode = "flakiest" | "slowest";

const DATE_RANGE_DAYS: Record<DateRange, number> = {
  "14d": 14,
  "30d": 30,
  "60d": 60,
  "90d": 90,
};

export class TestExplorerWebviewProvider
  implements vscode.WebviewViewProvider
{
  public static readonly viewType = "currents-test-explorer";

  private view?: vscode.WebviewView;
  private client: CurrentsApiClient | undefined;
  private projectId: string | undefined;
  private tests: TestExplorerItem[] = [];
  private loading = false;
  private dateRange: DateRange = "14d";
  private sortMode: SortMode = "flakiest";
  private page = 0;
  private total = 0;
  private hasMore = false;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setClient(client: CurrentsApiClient | undefined): void {
    this.client = client;
  }

  setProjectId(projectId: string | undefined): void {
    this.projectId = projectId;
    this.tests = [];
    this.page = 0;
    this.total = 0;
    this.hasMore = false;
    if (projectId) {
      this.fetchTests();
    } else {
      this.sendState();
    }
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

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "ready":
          this.sendState();
          break;
        case "changeDateRange":
          this.dateRange = message.range as DateRange;
          this.tests = [];
          this.page = 0;
          this.hasMore = false;
          this.fetchTests();
          break;
        case "changeSortMode":
          this.sortMode = message.mode as SortMode;
          this.tests = [];
          this.page = 0;
          this.hasMore = false;
          this.fetchTests();
          break;
        case "loadMore":
          if (this.hasMore && !this.loading) {
            this.page++;
            this.fetchTests(true);
          }
          break;
        case "goToFile":
          await this.handleGoToFile(message.spec, message.testTitle);
          break;
        case "fixWithAI":
          await this.handleFixWithAI(message);
          break;
      }
    });
  }

  private async fetchTests(append = false): Promise<void> {
    if (!this.client || !this.projectId) {
      return;
    }

    this.loading = true;
    this.sendState();

    try {
      const days = DATE_RANGE_DAYS[this.dateRange];
      const dateEnd = new Date();
      const dateStart = new Date();
      dateStart.setDate(dateEnd.getDate() - days);

      const order =
        this.sortMode === "flakiest" ? "flakinessXSamples" : "durationXSamples";

      const response = await this.client.getTestsExplorer(this.projectId, {
        date_start: dateStart.toISOString(),
        date_end: dateEnd.toISOString(),
        page: this.page,
        limit: 20,
        order,
        dir: "desc",
      });

      if (append) {
        this.tests.push(...response.data.list);
      } else {
        this.tests = response.data.list;
      }
      this.total = response.data.total;
      this.hasMore = typeof response.data.nextPage === "number";
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      log("TestExplorer: error fetching tests:", msg);
      vscode.window.showErrorMessage(
        `Currents: Failed to fetch tests. ${msg}`
      );
    } finally {
      this.loading = false;
      this.sendState();
    }
  }

  private sendState(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({
      type: "state",
      tests: this.tests.map(serializeTest),
      loading: this.loading,
      dateRange: this.dateRange,
      sortMode: this.sortMode,
      total: this.total,
      hasMore: this.hasMore,
    });
  }

  private async handleGoToFile(
    spec: string,
    testTitle: string
  ): Promise<void> {
    const files = await vscode.workspace.findFiles(
      `**/${spec}`,
      "**/node_modules/**",
      1
    );

    if (files.length === 0) {
      vscode.window.showWarningMessage(
        `Currents: Could not find file "${spec}" in workspace.`
      );
      return;
    }

    const doc = await vscode.workspace.openTextDocument(files[0]);
    const text = doc.getText();

    let line = 0;
    if (testTitle) {
      const idx = text.indexOf(testTitle);
      if (idx >= 0) {
        line = doc.positionAt(idx).line;
      }
    }

    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      selection: new vscode.Range(line, 0, line, 0),
    });
    editor.revealRange(
      new vscode.Range(line, 0, line, 0),
      vscode.TextEditorRevealType.InCenter
    );
  }

  private async handleFixWithAI(msg: {
    spec: string;
    testTitle: string;
    flakinessRate: number;
    avgDuration: number;
  }): Promise<void> {
    const prompt = `Please help me fix this flaky/slow test.\n\nFile: ${msg.spec}\nTest: ${msg.testTitle}\nFlakiness Rate: ${(msg.flakinessRate * 100).toFixed(1)}%\nAvg Duration: ${Math.round(msg.avgDuration)}ms`;
    try {
      await vscode.commands.executeCommand("workbench.action.chat.open", {
        query: prompt,
      });
    } catch {
      await vscode.env.clipboard.writeText(prompt);
      vscode.window.showInformationMessage(
        "Currents: Prompt copied to clipboard. Paste it in the AI chat."
      );
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

  .toolbar {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 0;
    position: sticky;
    top: 0;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    z-index: 10;
  }

  .tab-bar {
    display: flex;
    gap: 4px;
  }
  .tab-btn {
    flex: 1;
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 600;
    font-family: var(--vscode-font-family);
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border));
    border-radius: 4px;
    cursor: pointer;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    transition: all 0.15s;
  }
  .tab-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  .tab-btn.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
  }

  .date-bar {
    display: flex;
    gap: 4px;
  }
  .date-btn {
    flex: 1;
    padding: 4px 6px;
    font-size: 11px;
    font-family: var(--vscode-font-family);
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border));
    border-radius: 4px;
    cursor: pointer;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    transition: all 0.15s;
  }
  .date-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  .date-btn.active {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-color: var(--vscode-badge-background);
  }

  .summary {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    padding: 2px 0 4px;
  }

  .test-card {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border));
    border-radius: 6px;
    padding: 10px 12px;
    margin: 4px 0;
  }

  .test-spec {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-bottom: 3px;
  }

  .test-title {
    font-weight: 600;
    font-size: 13px;
    line-height: 1.3;
    margin-bottom: 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .test-metrics {
    display: flex;
    gap: 12px;
    font-size: 11px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .metric {
    display: flex;
    align-items: center;
    gap: 3px;
  }
  .metric-label {
    color: var(--vscode-descriptionForeground);
  }
  .metric-value {
    font-weight: 600;
  }
  .m-flaky { color: #e57ab0; }
  .m-duration { color: var(--vscode-testing-iconQueued); }
  .m-executions { color: var(--vscode-descriptionForeground); }

  .flaky-bar-track {
    height: 3px;
    background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
    border-radius: 2px;
    margin-bottom: 8px;
    overflow: hidden;
  }
  .flaky-bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.3s;
  }
  .fill-flaky { background: #e57ab0; }
  .fill-duration { background: var(--vscode-testing-iconQueued); }

  .test-actions {
    display: flex;
    gap: 6px;
  }
  .btn {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    font-family: var(--vscode-font-family);
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-primary:hover {
    background: var(--vscode-button-hoverBackground);
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
</style>
</head>
<body>
  <div class="toolbar">
    <div class="tab-bar">
      <button class="tab-btn active" data-mode="flakiest">\u2744 Flakiest</button>
      <button class="tab-btn" data-mode="slowest">\u23F1 Slowest</button>
    </div>
    <div class="date-bar">
      <button class="date-btn active" data-range="14d">14 days</button>
      <button class="date-btn" data-range="30d">30 days</button>
      <button class="date-btn" data-range="60d">60 days</button>
      <button class="date-btn" data-range="90d">90 days</button>
    </div>
  </div>
  <div class="summary" id="summary"></div>
  <div id="tests-container"></div>
  <script>
    const vscode = acquireVsCodeApi();

    let currentState = { tests: [], loading: false, dateRange: '14d', sortMode: 'flakiest', total: 0, hasMore: false };

    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (msg.type === 'state') {
        currentState = msg;
        render();
      }
    });

    document.querySelectorAll('.tab-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        vscode.postMessage({ type: 'changeSortMode', mode: btn.dataset.mode });
      });
    });

    document.querySelectorAll('.date-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        vscode.postMessage({ type: 'changeDateRange', range: btn.dataset.range });
      });
    });

    function formatDuration(ms) {
      if (!ms) return '0ms';
      if (ms < 1000) return Math.round(ms) + 'ms';
      var s = ms / 1000;
      if (s < 60) return s.toFixed(1) + 's';
      var m = Math.floor(s / 60);
      var rs = Math.round(s % 60);
      return m + 'm ' + rs + 's';
    }

    function render() {
      var container = document.getElementById('tests-container');
      var summary = document.getElementById('summary');
      var tests = currentState.tests;
      var sortMode = currentState.sortMode;
      var dateRange = currentState.dateRange;

      document.querySelectorAll('.tab-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.mode === sortMode);
      });
      document.querySelectorAll('.date-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.range === dateRange);
      });

      if (currentState.loading && tests.length === 0) {
        summary.textContent = '';
        container.innerHTML = '<div class="loading">Loading tests\u2026</div>';
        return;
      }

      if (tests.length === 0) {
        summary.textContent = '';
        container.innerHTML = '<div class="empty-state">No tests found for this period.</div>';
        return;
      }

      var rangeLabels = { '14d': '14 days', '30d': '30 days', '60d': '60 days', '90d': '90 days' };
      summary.textContent = 'Showing ' + tests.length + ' of ' + currentState.total + ' tests \u00B7 Last ' + rangeLabels[dateRange];

      var html = '';
      for (var i = 0; i < tests.length; i++) {
        var t = tests[i];
        var flakyPct = (t.flakinessRate * 100).toFixed(1);
        var barWidth = sortMode === 'flakiest'
          ? Math.min(t.flakinessRate * 100, 100)
          : Math.min((t.avgDurationMs / getMaxDuration(tests)) * 100, 100);
        var barClass = sortMode === 'flakiest' ? 'fill-flaky' : 'fill-duration';

        html += '<div class="test-card">';
        html += '  <div class="test-spec">' + escHtml(t.spec) + '</div>';
        html += '  <div class="test-title">' + escHtml(t.title) + '</div>';
        html += '  <div class="test-metrics">';
        html += '    <span class="metric"><span class="metric-label">Flaky:</span> <span class="metric-value m-flaky">' + flakyPct + '%</span></span>';
        html += '    <span class="metric"><span class="metric-label">Avg:</span> <span class="metric-value m-duration">' + formatDuration(t.avgDurationMs) + '</span></span>';
        html += '    <span class="metric"><span class="metric-label">Runs:</span> <span class="metric-value m-executions">' + t.executions + '</span></span>';
        html += '  </div>';
        html += '  <div class="flaky-bar-track"><div class="flaky-bar-fill ' + barClass + '" style="width:' + barWidth.toFixed(1) + '%"></div></div>';
        html += '  <div class="test-actions">';
        html += '    <button class="btn" data-action="goToFile" data-spec="' + escAttr(t.spec) + '" data-title="' + escAttr(t.lastTitle) + '">\u2197 Go to file</button>';
        html += '    <button class="btn btn-primary" data-action="fixWithAI" data-spec="' + escAttr(t.spec) + '" data-title="' + escAttr(t.title) + '" data-flakiness="' + t.flakinessRate + '" data-duration="' + t.avgDurationMs + '">\u2726 Fix with AI</button>';
        html += '  </div>';
        html += '</div>';
      }

      if (currentState.hasMore) {
        html += '<button class="load-more" id="load-more-btn">' + (currentState.loading ? 'Loading\u2026' : 'Load More Tests') + '</button>';
      }

      container.innerHTML = html;

      document.querySelectorAll('[data-action="goToFile"]').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          vscode.postMessage({
            type: 'goToFile',
            spec: btn.dataset.spec,
            testTitle: btn.dataset.title
          });
        });
      });

      document.querySelectorAll('[data-action="fixWithAI"]').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          vscode.postMessage({
            type: 'fixWithAI',
            spec: btn.dataset.spec,
            testTitle: btn.dataset.title,
            flakinessRate: parseFloat(btn.dataset.flakiness),
            avgDuration: parseFloat(btn.dataset.duration)
          });
        });
      });

      var loadMoreBtn = document.getElementById('load-more-btn');
      if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'loadMore' });
        });
      }
    }

    function getMaxDuration(tests) {
      var max = 0;
      for (var i = 0; i < tests.length; i++) {
        if (tests[i].avgDurationMs > max) max = tests[i].avgDurationMs;
      }
      return max || 1;
    }

    function escHtml(s) {
      var d = document.createElement('div');
      d.textContent = s || '';
      return d.innerHTML;
    }

    function escAttr(s) {
      return (s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    render();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function serializeTest(t: TestExplorerItem) {
  const titleParts = t.title.split(" > ");
  return {
    title: t.title,
    lastTitle: titleParts[titleParts.length - 1] || t.title,
    signature: t.signature,
    spec: t.spec,
    flakinessRate: t.metrics.flakinessRate,
    failureRate: t.metrics.failureRate,
    avgDurationMs: t.metrics.avgDurationMs,
    executions: t.metrics.executions,
    flaky: t.metrics.flaky,
    failures: t.metrics.failures,
  };
}
