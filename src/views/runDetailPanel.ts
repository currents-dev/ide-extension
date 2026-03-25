import * as vscode from "vscode";
import type { CurrentsApiClient } from "../api/client.js";
import type {
  InstanceTest,
  RunFeedItem,
  RunSpec,
} from "../api/types.js";
import { log } from "../log.js";

interface SerializedError {
  testId: string;
  title: string[];
  spec: string;
  displayError: string;
  attempts: Array<{
    error?: { message: string; stack: string } | null;
  }>;
}

interface SerializedSpec {
  spec: string;
  instanceId: string;
  status: string;
  testCount: number;
  failedCount: number;
  duration: number;
  errors: SerializedError[];
}

export class RunDetailPanelProvider {
  private panels = new Map<string, vscode.WebviewPanel>();
  private client: CurrentsApiClient | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setClient(client: CurrentsApiClient | undefined): void {
    this.client = client;
  }

  async openRun(run: RunFeedItem): Promise<void> {
    const existing = this.panels.get(run.runId);
    if (existing) {
      existing.reveal(vscode.ViewColumn.One);
      return;
    }

    const commitMsg =
      run.meta.commit?.message?.split("\n")[0] || "Run";
    const panel = vscode.window.createWebviewPanel(
      "currents-run-detail",
      `${commitMsg.slice(0, 50)}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      }
    );

    panel.iconPath = new vscode.ThemeIcon("beaker");
    this.panels.set(run.runId, panel);
    panel.onDidDispose(() => this.panels.delete(run.runId));

    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "fixWithAgent":
          await this.handleFixWithAgent(msg);
          break;
        case "goToFile":
          await this.handleGoToFile(msg.spec, msg.testTitle);
          break;
        case "openInDashboard":
          vscode.env.openExternal(
            vscode.Uri.parse(
              `https://app.currents.dev/run/${run.runId}`
            )
          );
          break;
        case "ready":
          await this.loadRunData(panel, run);
          break;
      }
    });

    panel.webview.html = this.getHtml(run);
  }

  private async loadRunData(
    panel: vscode.WebviewPanel,
    run: RunFeedItem
  ): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      log("RunDetailPanel: fetching run", run.runId);
      const { data: fullRun } = await this.client.getRun(run.runId);

      const failedSpecs = fullRun.specs.filter(
        (s: RunSpec) => s.results && s.results.stats.failures > 0
      );

      log("RunDetailPanel: failedSpecs:", failedSpecs.length);

      const instances = await Promise.all(
        failedSpecs.map((s: RunSpec) =>
          this.client!.getInstance(s.instanceId).then((res) => ({
            spec: s,
            instance: res.data,
          }))
        )
      );

      const specErrors: SerializedSpec[] = instances.map(
        ({ spec, instance }) => {
          const failedTests =
            instance.results?.tests.filter(
              (t) => t._f === true || t._s === "failed"
            ) ?? [];

          return {
            spec: spec.spec,
            instanceId: spec.instanceId,
            status: failedTests.length > 0 ? "failed" : "passed",
            testCount: instance.results?.stats.tests ?? 0,
            failedCount: failedTests.length,
            duration: spec.results?.stats.wallClockDuration ?? 0,
            errors: failedTests.map((t) => serializeTest(t)),
          };
        }
      );

      log(
        "RunDetailPanel: sending data, specs with errors:",
        specErrors.filter((s) => s.errors.length > 0).length
      );

      panel.webview.postMessage({
        type: "runData",
        specs: specErrors,
        allSpecs: fullRun.specs.map((s: RunSpec) => ({
          spec: s.spec,
          instanceId: s.instanceId,
          testCount: s.results?.stats.tests ?? 0,
          passes: s.results?.stats.passes ?? 0,
          failures: s.results?.stats.failures ?? 0,
          pending: s.results?.stats.pending ?? 0,
          skipped: s.results?.stats.skipped ?? 0,
          flaky: s.results?.stats.flaky ?? 0,
          duration: s.results?.stats.wallClockDuration ?? 0,
        })),
      });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Unknown error";
      log("RunDetailPanel: error fetching run data:", msg);
      panel.webview.postMessage({ type: "error", message: msg });
    }
  }

  private async handleFixWithAgent(msg: {
    spec: string;
    testTitle: string;
    displayError: string;
  }): Promise<void> {
    const prompt = `Please fix this failing test.\n\nFile: ${msg.spec}\nTest: ${msg.testTitle}\n\nError:\n${msg.displayError}`;
    try {
      await vscode.commands.executeCommand(
        "workbench.action.chat.open",
        { query: prompt }
      );
    } catch {
      await vscode.env.clipboard.writeText(prompt);
      vscode.window.showInformationMessage(
        "Currents: Prompt copied to clipboard. Paste it in the AI chat."
      );
    }
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

  private getHtml(run: RunFeedItem): string {
    const commit = run.meta.commit;
    const commitMsg = commit?.message?.split("\n")[0] || "No title";
    const branch = commit?.branch || "";
    const author = commit?.authorName || "";
    const sha = commit?.sha?.slice(0, 7) || "";
    const framework = run.meta.framework
      ? `${run.meta.framework.name} ${run.meta.framework.version}`
      : "";
    const createdAt = run.createdAt;
    const duration = run.durationMs;
    const tags = run.tags || [];

    let totalPasses = 0,
      totalFailures = 0,
      totalSkipped = 0,
      totalPending = 0,
      totalFlaky = 0,
      totalTests = 0;
    for (const g of run.groups) {
      totalPasses += g.tests.passes;
      totalFailures += g.tests.failures;
      totalSkipped += g.tests.skipped;
      totalPending += g.tests.pending;
      totalFlaky += g.tests.flaky;
      totalTests += g.tests.overall;
    }

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
    background: var(--vscode-editor-background);
    padding: 0;
    line-height: 1.5;
  }

  .header {
    padding: 20px 24px 16px;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border));
  }

  .header-top {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }

  .status-badge {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 3px 10px;
    border-radius: 4px;
    flex-shrink: 0;
  }
  .status-passed {
    background: color-mix(in srgb, var(--vscode-testing-iconPassed) 20%, transparent);
    color: var(--vscode-testing-iconPassed);
  }
  .status-failed {
    background: color-mix(in srgb, var(--vscode-testing-iconFailed) 20%, transparent);
    color: var(--vscode-testing-iconFailed);
  }
  .status-running {
    background: color-mix(in srgb, var(--vscode-testing-iconQueued) 20%, transparent);
    color: var(--vscode-testing-iconQueued);
  }
  .status-cancelled, .status-timedOut {
    background: color-mix(in srgb, var(--vscode-disabledForeground) 20%, transparent);
    color: var(--vscode-disabledForeground);
  }

  .commit-message {
    font-size: 16px;
    font-weight: 600;
    line-height: 1.3;
  }

  .header-actions {
    margin-left: auto;
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }
  .header-btn {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-family: var(--vscode-font-family);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .header-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .meta-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 14px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    margin-top: 8px;
  }
  .meta-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .meta-icon { opacity: 0.8; }

  .tags-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 8px;
  }
  .tag {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 11px;
  }

  .stats-bar {
    display: flex;
    gap: 16px;
    padding: 12px 24px;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border));
    font-size: 13px;
    font-weight: 500;
  }
  .stat-item {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .stat-num { font-weight: 700; font-size: 15px; }
  .stat-label { color: var(--vscode-descriptionForeground); }
  .c-total { color: var(--vscode-foreground); }
  .c-pass { color: var(--vscode-testing-iconPassed); }
  .c-fail { color: var(--vscode-testing-iconFailed); }
  .c-skip { color: var(--vscode-descriptionForeground); }
  .c-flaky { color: var(--vscode-editorWarning-foreground); }

  .content {
    padding: 16px 24px;
  }

  .loading-state {
    text-align: center;
    padding: 40px;
    color: var(--vscode-descriptionForeground);
  }
  .spinner {
    display: inline-block;
    width: 20px;
    height: 20px;
    border: 2px solid var(--vscode-descriptionForeground);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-bottom: 8px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .error-state {
    text-align: center;
    padding: 40px;
    color: var(--vscode-errorForeground);
  }

  .section-title {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 12px;
  }

  .spec-group {
    margin-bottom: 16px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border));
    border-radius: 6px;
    overflow: hidden;
  }

  .spec-header {
    display: flex;
    align-items: center;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--vscode-sideBar-background, var(--vscode-editor-background)) 50%, transparent);
    cursor: pointer;
    user-select: none;
    gap: 8px;
  }
  .spec-header:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .spec-chevron {
    transition: transform 0.15s;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
  }
  .spec-chevron.open { transform: rotate(90deg); }

  .spec-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot-failed { background: var(--vscode-testing-iconFailed); }
  .dot-passed { background: var(--vscode-testing-iconPassed); }
  .dot-flaky { background: var(--vscode-editorWarning-foreground); }

  .spec-name {
    font-weight: 500;
    font-size: 13px;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .spec-meta {
    display: flex;
    gap: 10px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
  }

  .spec-body {
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border));
  }
  .spec-body.collapsed { display: none; }

  .error-item {
    padding: 12px 14px 12px 30px;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorGroup-border));
  }
  .error-item:last-child { border-bottom: none; }

  .error-title-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-bottom: 6px;
  }
  .error-icon {
    color: var(--vscode-testing-iconFailed);
    flex-shrink: 0;
    margin-top: 2px;
  }
  .error-test-name {
    font-weight: 500;
    font-size: 13px;
    flex: 1;
  }

  .error-message {
    background: var(--vscode-textCodeBlock-background, color-mix(in srgb, var(--vscode-foreground) 8%, transparent));
    border-radius: 4px;
    padding: 10px 12px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
    margin-bottom: 8px;
    color: var(--vscode-errorForeground, var(--vscode-foreground));
  }

  .error-actions {
    display: flex;
    gap: 8px;
  }

  .btn {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
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

  .empty-errors {
    text-align: center;
    padding: 24px;
    color: var(--vscode-descriptionForeground);
  }
</style>
</head>
<body>
  <div class="header">
    <div class="header-top">
      <span class="status-badge status-${esc(run.status)}">${esc(run.status)}</span>
      <span class="commit-message">${esc(commitMsg)}</span>
      <div class="header-actions">
        <button class="header-btn" id="btn-dashboard">↗ Dashboard</button>
      </div>
    </div>
    <div class="meta-row">
      ${sha ? `<span class="meta-item"><span class="meta-icon">⊙</span> ${esc(sha)}</span>` : ""}
      ${branch ? `<span class="meta-item"><span class="meta-icon">⑂</span> ${esc(branch)}</span>` : ""}
      ${author ? `<span class="meta-item"><span class="meta-icon">☺</span> ${esc(author)}</span>` : ""}
      ${duration ? `<span class="meta-item"><span class="meta-icon">◷</span> ${formatDuration(duration)}</span>` : ""}
      <span class="meta-item"><span class="meta-icon">◷</span> ${esc(formatDate(createdAt))}</span>
      ${framework ? `<span class="meta-item"><span class="meta-icon">⬡</span> ${esc(framework)}</span>` : ""}
    </div>
    ${
      tags.length > 0
        ? `<div class="tags-row">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>`
        : ""
    }
  </div>

  <div class="stats-bar">
    <span class="stat-item c-total"><span class="stat-num">${totalTests}</span> <span class="stat-label">tests</span></span>
    <span class="stat-item c-pass"><span class="stat-num">${totalPasses}</span> <span class="stat-label">passed</span></span>
    <span class="stat-item c-fail"><span class="stat-num">${totalFailures}</span> <span class="stat-label">failed</span></span>
    <span class="stat-item c-skip"><span class="stat-num">${totalSkipped + totalPending}</span> <span class="stat-label">skipped</span></span>
    ${totalFlaky > 0 ? `<span class="stat-item c-flaky"><span class="stat-num">${totalFlaky}</span> <span class="stat-label">flaky</span></span>` : ""}
  </div>

  <div class="content" id="content">
    <div class="loading-state" id="loading">
      <div class="spinner"></div>
      <div>Loading spec details…</div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    document.getElementById('btn-dashboard').addEventListener('click', () => {
      vscode.postMessage({ type: 'openInDashboard' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'runData') {
        renderSpecs(msg.specs);
      } else if (msg.type === 'error') {
        document.getElementById('content').innerHTML =
          '<div class="error-state">Failed to load: ' + escHtml(msg.message) + '</div>';
      }
    });

    function renderSpecs(specs) {
      const content = document.getElementById('content');

      const withErrors = specs.filter(s => s.errors.length > 0);

      if (withErrors.length === 0) {
        content.innerHTML = '<div class="empty-errors">No errors found in this run.</div>';
        return;
      }

      let html = '<div class="section-title">Errors by spec file (' + withErrors.length + ' files)</div>';

      for (const spec of withErrors) {
        html += '<div class="spec-group">';
        html += '  <div class="spec-header" data-spec="' + escAttr(spec.spec) + '">';
        html += '    <span class="spec-chevron open">▶</span>';
        html += '    <span class="spec-status-dot dot-failed"></span>';
        html += '    <span class="spec-name">' + escHtml(spec.spec) + '</span>';
        html += '    <span class="spec-meta">';
        html += '      <span style="color:var(--vscode-testing-iconFailed)">' + spec.failedCount + ' failed</span>';
        html += '      <span>' + spec.testCount + ' tests</span>';
        if (spec.duration) {
          html += '      <span>' + formatDuration(spec.duration) + '</span>';
        }
        html += '    </span>';
        html += '  </div>';
        html += '  <div class="spec-body" data-body="' + escAttr(spec.spec) + '">';

        for (const err of spec.errors) {
          const title = err.title.join(' > ');
          const lastTitle = err.title[err.title.length - 1] || '';
          const errorText = err.displayError
            || (err.attempts && err.attempts.find(a => a.error)?.error?.message)
            || 'Unknown error';

          html += '<div class="error-item">';
          html += '  <div class="error-title-row">';
          html += '    <span class="error-icon">✕</span>';
          html += '    <span class="error-test-name">' + escHtml(title) + '</span>';
          html += '  </div>';
          html += '  <div class="error-message">' + escHtml(errorText.slice(0, 2000)) + '</div>';
          html += '  <div class="error-actions">';
          html += '    <button class="btn" data-action="goToFile" data-spec="' + escAttr(spec.spec) + '" data-title="' + escAttr(lastTitle) + '">↗ Go to file</button>';
          html += '    <button class="btn btn-primary" data-action="fixWithAgent" data-spec="' + escAttr(spec.spec) + '" data-title="' + escAttr(title) + '" data-error="' + escAttr(errorText.slice(0, 2000)) + '">✦ Fix with Agent</button>';
          html += '  </div>';
          html += '</div>';
        }

        html += '  </div>';
        html += '</div>';
      }

      content.innerHTML = html;

      document.querySelectorAll('.spec-header').forEach(header => {
        header.addEventListener('click', () => {
          const specName = header.dataset.spec;
          const body = document.querySelector('[data-body="' + specName + '"]');
          const chevron = header.querySelector('.spec-chevron');
          if (body.classList.contains('collapsed')) {
            body.classList.remove('collapsed');
            chevron.classList.add('open');
          } else {
            body.classList.add('collapsed');
            chevron.classList.remove('open');
          }
        });
      });

      document.querySelectorAll('[data-action="goToFile"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({
            type: 'goToFile',
            spec: btn.dataset.spec,
            testTitle: btn.dataset.title
          });
        });
      });

      document.querySelectorAll('[data-action="fixWithAgent"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({
            type: 'fixWithAgent',
            spec: btn.dataset.spec,
            testTitle: btn.dataset.title,
            displayError: btn.dataset.error
          });
        });
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

    function escHtml(s) {
      const d = document.createElement('div');
      d.textContent = s || '';
      return d.innerHTML;
    }

    function escAttr(s) {
      return (s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function serializeTest(t: InstanceTest): SerializedError {
  return {
    testId: t.testId,
    title: t.title,
    spec: t.spec,
    displayError: t.displayError || "",
    attempts: (t.attempts || []).map((a) => ({
      error: a.error ?? null,
    })),
  };
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDuration(ms: number | null): string {
  if (!ms) {
    return "";
  }
  const s = Math.floor(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) {
    return `${m}m ${rs}s`;
  }
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString();
}
