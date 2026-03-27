import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { CurrentsApiClient } from "../api/client.js";
import type {
  InstanceTest,
  InstanceTestResult,
  RunFeedItem,
  RunSpec,
} from "../api/types.js";
import { log } from "../log.js";

interface SerializedError {
  testId: string;
  title: string[];
  spec: string;
  displayError: string;
  isFlaky: boolean;
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
  flakyCount: number;
  duration: number;
  errors: SerializedError[];
}

export class RunDetailPanelProvider {
  private panels = new Map<string, vscode.WebviewPanel>();
  private runIdByPanel = new Map<vscode.WebviewPanel, string>();
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private client: CurrentsApiClient | undefined;
  private _onActiveRunChanged:
    | ((runId: string | undefined) => void)
    | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  set onActiveRunChanged(cb: (runId: string | undefined) => void) {
    this._onActiveRunChanged = cb;
  }

  setClient(client: CurrentsApiClient | undefined): void {
    this.client = client;
  }

  async openRun(run: RunFeedItem): Promise<void> {
    const existing = this.panels.get(run.runId);
    if (existing) {
      existing.reveal(vscode.ViewColumn.One);
      return;
    }

    const commitMsg = run.meta.commit?.message?.split("\n")[0] || "Run";
    const panel = vscode.window.createWebviewPanel(
      "currents-run-detail",
      `${commitMsg.slice(0, 50)}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );

    panel.iconPath = new vscode.ThemeIcon("beaker");
    this.panels.set(run.runId, panel);
    this.runIdByPanel.set(panel, run.runId);

    panel.onDidDispose(() => {
      this.panels.delete(run.runId);
      this.runIdByPanel.delete(panel);
      this.stopPolling(run.runId);
      this.notifyActiveRun();
    });

    panel.onDidChangeViewState(() => {
      this.notifyActiveRun();
    });

    this._onActiveRunChanged?.(run.runId);

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
            vscode.Uri.parse(`https://app.currents.dev/run/${run.runId}`),
          );
          break;
        case "ready":
          await this.loadRunData(panel, run);
          break;
      }
    });

    panel.webview.html = this.getHtml(run);
  }

  private notifyActiveRun(): void {
    for (const [panel, runId] of this.runIdByPanel) {
      if (panel.visible) {
        this._onActiveRunChanged?.(runId);
        return;
      }
    }
    this._onActiveRunChanged?.(undefined);
  }

  private async loadRunData(
    panel: vscode.WebviewPanel,
    run: RunFeedItem,
  ): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      log("RunDetailPanel: fetching run", run.runId);
      const { data: fullRun } = await this.client.getRun(run.runId);

      const isInProgress = isRunInProgress(fullRun.completionState);

      const specsWithIssues = fullRun.specs.filter(
        (s: RunSpec) =>
          s.results &&
          (s.results.stats.failures > 0 || s.results.stats.flaky > 0),
      );

      log("RunDetailPanel: specsWithIssues:", specsWithIssues.length);

      const instances = await Promise.all(
        specsWithIssues.map((s: RunSpec) =>
          this.client!.getInstance(s.instanceId).then((res) => ({
            spec: s,
            instance: res.data,
          })),
        ),
      );

      const specErrors: SerializedSpec[] = instances.map(
        ({ spec, instance }) => {
          const tr = instance.testResults ?? {};

          const failedTests =
            instance.results?.tests.filter((t) => t._s === "failed") ?? [];

          const flakyTests =
            instance.results?.tests.filter(
              (t) =>
                t._s === "passed" &&
                (t._f === true || tr[t.testId]?.isFlaky === true),
            ) ?? [];

          const allIssueTests = [
            ...failedTests.map((t) => serializeTest(t, false, tr[t.testId])),
            ...flakyTests.map((t) => serializeTest(t, true, tr[t.testId])),
          ];

          return {
            spec: spec.spec,
            instanceId: spec.instanceId,
            status: failedTests.length > 0 ? "failed" : "flaky",
            testCount: instance.results?.stats.tests ?? 0,
            failedCount: failedTests.length,
            flakyCount: flakyTests.length,
            duration: spec.results?.stats.wallClockDuration ?? 0,
            errors: allIssueTests,
          };
        },
      );

      log(
        "RunDetailPanel: sending data, specs with errors:",
        specErrors.filter((s) => s.errors.length > 0).length,
      );

      let totalPasses = 0,
        totalFailures = 0,
        totalSkipped = 0,
        totalPending = 0,
        totalFlaky = 0,
        totalTests = 0;
      for (const g of fullRun.groups) {
        totalPasses += g.tests.passes;
        totalFailures += g.tests.failures;
        totalSkipped += g.tests.skipped;
        totalPending += g.tests.pending;
        totalFlaky += g.tests.flaky;
        totalTests += g.tests.overall;
      }

      panel.webview.postMessage({
        type: "runData",
        specs: specErrors,
        completionState: fullRun.completionState,
        status: fullRun.status,
        stats: {
          totalTests,
          totalPasses,
          totalFailures,
          totalSkipped,
          totalPending,
          totalFlaky,
        },
        allSpecs: fullRun.specs.map((s: RunSpec) => ({
          spec: s.spec,
          instanceId: s.instanceId,
          completed: s.completedAt !== null,
          testCount: s.results?.stats.tests ?? 0,
          passes: s.results?.stats.passes ?? 0,
          failures: s.results?.stats.failures ?? 0,
          pending: s.results?.stats.pending ?? 0,
          skipped: s.results?.stats.skipped ?? 0,
          flaky: s.results?.stats.flaky ?? 0,
          duration: s.results?.stats.wallClockDuration ?? 0,
        })),
      });

      if (isInProgress) {
        this.startPolling(panel, run);
      } else {
        this.stopPolling(run.runId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      log("RunDetailPanel: error fetching run data:", msg);
      panel.webview.postMessage({ type: "error", message: msg });
    }
  }

  private startPolling(panel: vscode.WebviewPanel, run: RunFeedItem): void {
    if (this.pollTimers.has(run.runId)) {
      return;
    }
    const timer = setInterval(() => {
      if (panel.visible) {
        this.loadRunData(panel, run);
      }
    }, 10_000);
    this.pollTimers.set(run.runId, timer);
  }

  private stopPolling(runId: string): void {
    const timer = this.pollTimers.get(runId);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(runId);
    }
  }

  private async handleFixWithAgent(msg: {
    spec: string;
    testTitle: string;
    displayError: string;
  }): Promise<void> {
    const prompt = `Please fix this failing test.\n\nFile: ${msg.spec}\nTest: ${msg.testTitle}\n\nError:\n${msg.displayError}`;
    try {
      await vscode.commands.executeCommand("workbench.action.chat.open", {
        query: prompt,
      });
    } catch {
      await vscode.env.clipboard.writeText(prompt);
      vscode.window.showInformationMessage(
        "Currents: Prompt copied to clipboard. Paste it in the AI chat.",
      );
    }
  }

  private async handleGoToFile(spec: string, testTitle: string): Promise<void> {
    const files = await vscode.workspace.findFiles(
      `**/${spec}`,
      "**/node_modules/**",
      1,
    );

    if (files.length === 0) {
      vscode.window.showWarningMessage(
        `Currents: Could not find file "${spec}" in workspace.`,
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
      vscode.TextEditorRevealType.InCenter,
    );
  }

  private getHtml(run: RunFeedItem): string {
    const htmlPath = path.join(
      this.extensionUri.fsPath,
      "src",
      "views",
      "runDetail.html",
    );
    let html = fs.readFileSync(htmlPath, "utf-8");

    const commit = run.meta.commit;
    const commitMsg = commit?.message?.split("\n")[0] || "No title";

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

    const initData = {
      status: run.status.toLowerCase(),
      commitMsg,
      sha: commit?.sha?.slice(0, 7) || "",
      branch: commit?.branch || "",
      author: commit?.authorName || "",
      duration: formatDuration(run.durationMs),
      createdAt: formatDate(run.createdAt),
      framework: run.meta.framework
        ? `${run.meta.framework.type} ${run.meta.framework.version}`
        : "",
      tags: run.tags || [],
      isInProgress: isRunInProgress(run.completionState),
      stats: {
        totalTests,
        totalPasses,
        totalFailures,
        totalSkipped,
        totalPending,
        totalFlaky,
      },
    };

    html = html.replace("/**__INIT_DATA__**/null", JSON.stringify(initData));

    return html;
  }
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u001b\[[0-9;]*m/g, "");
}

function serializeTest(
  t: InstanceTest,
  isFlaky: boolean,
  detail?: InstanceTestResult,
): SerializedError {
  const errorText = stripAnsi(
    detail?.displayError ||
      t.displayError ||
      detail?.attempts?.find((a) => a.error)?.error?.message ||
      t.attempts?.find((a) => a.error)?.error?.message ||
      "",
  );
  const attempts = detail?.attempts ?? t.attempts ?? [];
  return {
    testId: t.testId,
    title: t.title,
    spec: t.spec,
    displayError: errorText,
    isFlaky,
    attempts: attempts.map((a) => ({
      error: a.error ?? null,
    })),
  };
}

function isRunInProgress(completionState: string): boolean {
  const v = completionState.toLowerCase();
  return v === "incomplete" || v === "in_progress";
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
