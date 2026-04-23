import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { CurrentsApiClient } from "../../api/client.js";
import { getCodiconCss } from "../codiconCss.js";
import type {
  InstanceTest,
  InstanceTestResult,
  InstanceTrace,
  RunFeedItem,
  RunSpec,
} from "../../api/types.js";
import { log } from "../../lib/log.js";
import { resolveRunTitleFromFeedItem } from "../../lib/runTitle.js";
import {
  buildBasicPrompt,
  buildEnrichedPrompt,
  writeContextFiles,
  writeRunContextFiles,
} from "../../aiContext.js";
import { isAiContextFetchEnabled } from "../../featureFlags.js";

interface SerializedError {
  testId: string;
  title: string[];
  spec: string;
  displayError: string;
  isFlaky: boolean;
  traceUrl: string;
  attempts: Array<{
    state?: string;
    wallClockStartedAt?: string;
    wallClockDuration?: number;
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
  private lastSpecErrors = new Map<string, SerializedSpec[]>();
  private runProjectIds = new Map<string, string>();
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

    const displayTitle = resolveRunTitleFromFeedItem(run);
    const panelTitle =
      displayTitle.length > 50
        ? `${displayTitle.slice(0, 50)}\u2026`
        : displayTitle;
    const panel = vscode.window.createWebviewPanel(
      "currents-run-detail",
      panelTitle,
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
    this.runProjectIds.set(run.runId, run.projectId);

    panel.onDidDispose(() => {
      this.panels.delete(run.runId);
      this.runIdByPanel.delete(panel);
      this.lastSpecErrors.delete(run.runId);
      this.runProjectIds.delete(run.runId);
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
        case "openInstanceDashboard":
          vscode.env.openExternal(
            vscode.Uri.parse(
              `https://app.currents.dev/instance/${msg.instanceId}`,
            ),
          );
          break;
        case "openTestDashboard":
          vscode.env.openExternal(
            vscode.Uri.parse(
              `https://app.currents.dev/instance/${msg.instanceId}/test/${msg.testId}`,
            ),
          );
          break;
        case "fixAllWithAgent":
          await this.handleFixAllWithAgent(run.runId);
          break;
        case "ready":
          await this.loadRunData(panel, run);
          break;
      }
    });

    panel.webview.html = this.getHtml(panel.webview, run);
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

          const traces = instance.results?.playwrightTraces ?? [];
          const allIssueTests = [
            ...failedTests.map((t) =>
              serializeTest(t, false, tr[t.testId], traces),
            ),
            ...flakyTests.map((t) =>
              serializeTest(t, true, tr[t.testId], traces),
            ),
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

      this.lastSpecErrors.set(run.runId, specErrors);

      const resolvedTitle = resolveRunTitleFromFeedItem(fullRun);
      panel.title =
        resolvedTitle.length > 50
          ? `${resolvedTitle.slice(0, 50)}\u2026`
          : resolvedTitle;

      panel.webview.postMessage({
        type: "runData",
        displayTitle: resolvedTitle,
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
    instanceId?: string;
    testId?: string;
    attempt?: number;
  }): Promise<void> {
    log("handleFixWithAgent called with:", {
      spec: msg.spec,
      testTitle: msg.testTitle,
      instanceId: msg.instanceId,
      testId: msg.testId,
      hasClient: !!this.client,
    });

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Currents: Loading test context...",
        cancellable: false,
      },
      async () => {
        let prompt: string;
        let attachFiles: vscode.Uri[] = [];

        if (
          isAiContextFetchEnabled() &&
          this.client &&
          msg.instanceId &&
          msg.testId
        ) {
          try {
            log("Fetching AI context for", msg.instanceId, msg.testId, "attempt:", msg.attempt);
            const [markdown, errorContextUrl] = await Promise.all([
              this.client.getAiContext(
                msg.instanceId,
                msg.testId,
                msg.attempt,
              ),
              this.client
                .getAiContextErrorContextUrl(
                  msg.instanceId,
                  msg.testId,
                  msg.attempt,
                )
                .catch(() => null),
            ]);
            log("AI context fetched successfully");
            prompt = buildEnrichedPrompt(msg.spec, markdown);
            attachFiles = await writeContextFiles(this.client, errorContextUrl);
          } catch (err) {
            log("AI context fetch failed, using basic prompt:", err);
            prompt = buildBasicPrompt(msg);
          }
        } else {
          log(
            "Using basic prompt - missing:",
            !this.client ? "client" : "",
            !msg.instanceId ? "instanceId" : "",
            !msg.testId ? "testId" : "",
          );
          prompt = buildBasicPrompt(msg);
        }

        try {
          log(
            "Opening chat with prompt length:",
            prompt.length,
            "attachFiles:",
            attachFiles.length,
          );
          await vscode.commands.executeCommand("workbench.action.chat.open", {
            query: prompt,
            ...(attachFiles.length > 0 ? { attachFiles } : {}),
          });
        } catch {
          await vscode.env.clipboard.writeText(prompt);
          vscode.window.showInformationMessage(
            "Currents: Prompt copied to clipboard. Paste it in the AI chat.",
          );
        }
      },
    );
  }

  private buildBasicRunPrompt(
    runId: string,
    specErrors: SerializedSpec[],
    failedTests: Array<{
      spec: string;
      instanceId: string;
      title: string;
      testId: string;
      errorPreview: string;
    }>,
    projectId: string | undefined,
  ): string {
    const lines: string[] = [];
    lines.push(
      `This CI run has **${failedTests.length} failing test(s)** across ${specErrors.filter((s) => s.errors.some((e) => !e.isFlaky)).length} spec file(s).`,
    );
    lines.push("");
    lines.push("Please:");
    lines.push("1. For each failing test below, use `currents-get-spec-instance` with the instance ID to get full failure details and stack traces");
    lines.push("2. Use `currents-get-tests-signatures` with the project ID, spec file path, and test title to get test signatures, then use `currents-get-test-results` to retrieve historical results and check for flakiness patterns");
    lines.push("3. Open each spec file, locate the failing test, and analyze the root cause");
    lines.push("4. Build a plan to fix all failures, then implement the fixes");
    lines.push("");
    lines.push("## Run metadata (for MCP queries)");
    lines.push("");
    if (projectId) lines.push(`- **Project ID:** \`${projectId}\``);
    lines.push(`- **Run ID:** \`${runId}\``);
    lines.push("");
    lines.push("## Failing tests");
    lines.push("");

    for (const t of failedTests) {
      lines.push(`### ${t.title}`);
      lines.push(`- **Spec:** \`${t.spec}\``);
      lines.push(`- **Instance ID:** \`${t.instanceId}\``);
      lines.push(`- **Test ID:** \`${t.testId}\``);
      if (t.errorPreview) lines.push(`- **Error:** \`${t.errorPreview}\``);
      lines.push("");
    }

    lines.push(
      "Use the Currents MCP tools (`currents-get-spec-instance`, `currents-get-tests-signatures`, `currents-get-test-results`, `currents-get-run-details`) with the identifiers above to retrieve full context before fixing.",
    );

    return lines.join("\n");
  }

  private async handleFixAllWithAgent(runId: string): Promise<void> {
    const specErrors = this.lastSpecErrors.get(runId);
    if (!specErrors || specErrors.length === 0) {
      vscode.window.showInformationMessage(
        "Currents: No failures found in this run.",
      );
      return;
    }

    const projectId = this.runProjectIds.get(runId);

    const failedTests: Array<{
      spec: string;
      instanceId: string;
      title: string;
      testId: string;
      errorPreview: string;
    }> = [];

    for (const spec of specErrors) {
      for (const err of spec.errors) {
        if (err.isFlaky) continue;
        failedTests.push({
          spec: spec.spec,
          instanceId: spec.instanceId,
          title: err.title.join(" > "),
          testId: err.testId,
          errorPreview: (err.displayError || "").split("\n")[0].slice(0, 120),
        });
      }
    }

    if (failedTests.length === 0) {
      vscode.window.showInformationMessage(
        "Currents: No non-flaky failures found in this run.",
      );
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Currents: Loading run context...",
        cancellable: false,
      },
      async () => {
        let prompt: string | null = null;
        let attachFiles: vscode.Uri[] = [];

        if (isAiContextFetchEnabled() && this.client) {
          try {
            const [markdown, errorContexts] = await Promise.all([
              this.client.getRunAiContext(runId),
              this.client
                .getRunAiContextErrorContexts(runId)
                .catch(() => []),
            ]);
            prompt = `Fix the Playwright test failures in this run:\n\n${markdown}`;
            attachFiles = await writeRunContextFiles(
              this.client,
              runId,
              errorContexts,
            );
          } catch (err) {
            log("Run AI context fetch failed, using basic prompt:", err);
          }
        }

        if (!prompt) {
          prompt = this.buildBasicRunPrompt(
            runId,
            specErrors,
            failedTests,
            projectId,
          );
        }

        try {
          await vscode.commands.executeCommand("workbench.action.chat.open", {
            query: prompt,
            ...(attachFiles.length > 0 ? { attachFiles } : {}),
          });
        } catch {
          await vscode.env.clipboard.writeText(prompt);
          vscode.window.showInformationMessage(
            "Currents: Prompt copied to clipboard. Paste it in the AI chat.",
          );
        }
      },
    );
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

  private getHtml(webview: vscode.Webview, run: RunFeedItem): string {
    const htmlPath = path.join(
      this.extensionUri.fsPath,
      "src",
      "views",
      "runDetail",
      "runDetail.html",
    );
    let html = fs.readFileSync(htmlPath, "utf-8");
    html = html.replace(
      "/**__CODICON_CSS__**/",
      getCodiconCss(webview, this.extensionUri),
    );

    const commit = run.meta.commit;
    const displayTitle = resolveRunTitleFromFeedItem(run);

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
      displayTitle,
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

    html = html.replace("/**__INIT_DATA__**/ null", JSON.stringify(initData));

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
  traces?: InstanceTrace[],
): SerializedError {
  const errorText = stripAnsi(
    detail?.displayError ||
      t.displayError ||
      detail?.attempts?.find((a) => a.error)?.error?.message ||
      t.attempts?.find((a) => a.error)?.error?.message ||
      "",
  );
  const attempts = detail?.attempts ?? t.attempts ?? [];

  const matchingTraces = (traces ?? []).filter((tr) => tr.testId === t.testId);
  const bestTrace = matchingTraces.sort(
    (a, b) => b.testAttemptIndex - a.testAttemptIndex,
  )[0];

  return {
    testId: t.testId,
    title: t.title,
    spec: t.spec,
    displayError: errorText,
    isFlaky,
    traceUrl: bestTrace?.traceURL ?? "",
    attempts: attempts.map((a) => ({
      state: a.state,
      wallClockStartedAt: a.wallClockStartedAt,
      wallClockDuration: a.wallClockDuration,
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
