import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { CurrentsApiClient } from "../../api/client.js";
import type { TestExplorerItem } from "../../api/types.js";
import { getCodiconCss } from "../codiconCss.js";
import { buildPromptMarkdown, writeContextFiles } from "../../aiContext.js";
import { log } from "../../lib/log.js";

type DateRange = "14d" | "30d" | "60d" | "90d";
type SortMode = "flakiest" | "slowest";

const DATE_RANGE_DAYS: Record<DateRange, number> = {
  "14d": 14,
  "30d": 30,
  "60d": 60,
  "90d": 90,
};

export class TestExplorerWebviewProvider implements vscode.WebviewViewProvider {
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
  private authenticated = false;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setClient(client: CurrentsApiClient | undefined): void {
    this.client = client;
    this.authenticated = client !== undefined;
    this.sendState();
  }

  getDateRange(): DateRange {
    return this.dateRange;
  }

  setDateRange(range: DateRange): void {
    this.dateRange = range;
    this.tests = [];
    this.page = 0;
    this.hasMore = false;
    this.fetchTests();
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
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "ready":
          this.sendState();
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
        case "setApiKey":
          vscode.commands.executeCommand("currents.setApiKey");
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
      vscode.window.showErrorMessage(`Currents: Failed to fetch tests. ${msg}`);
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
      authenticated: this.authenticated,
    });
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

  private async handleFixWithAI(msg: {
    spec: string;
    testTitle: string;
    signature?: string;
    flakinessRate: number;
    avgDuration: number;
    sortMode?: string;
  }): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Currents: Loading test context...",
        cancellable: false,
      },
      async () => {
        const mode = msg.sortMode === "slowest" ? "slowest" : "flakiest";
        let prompt: string;
        let attachFiles: vscode.Uri[] = [];

        if (this.client && this.projectId && msg.signature) {
          try {
            const payload = await this.client.getAiContextBySignature(
              this.projectId,
              msg.signature,
            );
            const contextMarkdown = buildPromptMarkdown(payload);
            prompt = this.buildExplorerPrompt(mode, msg, this.projectId, contextMarkdown);
            attachFiles = await writeContextFiles(this.client, payload);
          } catch (err) {
            log(
              "TestExplorer: AI context fetch failed, using basic prompt:",
              err,
            );
            prompt = this.buildExplorerPrompt(mode, msg, this.projectId);
          }
        } else {
          prompt = this.buildExplorerPrompt(mode, msg, this.projectId);
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

  private buildExplorerPrompt(
    mode: "flakiest" | "slowest",
    msg: { spec: string; testTitle: string; flakinessRate: number; avgDuration: number; signature?: string },
    projectId?: string,
    additionalContext?: string,
  ): string {
    const lines: string[] = [];

    if (mode === "flakiest") {
      lines.push(
        `The test **"${msg.testTitle}"** in \`${msg.spec}\` has been identified as **flaky** with a flakiness rate of **${(msg.flakinessRate * 100).toFixed(1)}%**.`,
      );
      lines.push("");
      lines.push("Please:");
      lines.push("1. Open the test file and analyze the test code for common flakiness causes (race conditions, timing dependencies, shared state, non-deterministic data, missing waits/retries)");
      lines.push("2. Use `currents-get-test-results` with the test signature and project ID below to retrieve recent execution history and failure patterns");
      lines.push("3. Compare passing vs failing attempts to identify what differs");
      lines.push("4. Build a concrete plan to eliminate the flakiness, then implement the fix");
    } else {
      lines.push(
        `The test **"${msg.testTitle}"** in \`${msg.spec}\` has been identified as **unusually slow** with an average duration of **${formatDurationForPrompt(msg.avgDuration)}**.`,
      );
      lines.push("");
      lines.push("Please:");
      lines.push("1. Open the test file and analyze the test code for performance bottlenecks (unnecessary setup/teardown, redundant operations, expensive fixtures, missing parallelism)");
      lines.push("2. Use `currents-get-test-results` with the test signature and project ID below to retrieve recent execution history and duration trends");
      lines.push("3. Identify which parts of the test contribute most to the slow execution time");
      lines.push("4. Build a concrete plan to reduce the test duration, then implement the fix");
    }

    lines.push("");
    lines.push("## Metadata (for MCP queries)");
    lines.push("");
    if (projectId) lines.push(`- **Project ID:** \`${projectId}\``);
    lines.push(`- **Spec:** \`${msg.spec}\``);
    lines.push(`- **Test:** ${msg.testTitle}`);
    if (msg.signature) lines.push(`- **Signature:** \`${msg.signature}\``);
    lines.push(`- **Flakiness Rate:** ${(msg.flakinessRate * 100).toFixed(1)}%`);
    lines.push(`- **Avg Duration:** ${formatDurationForPrompt(msg.avgDuration)}`);
    lines.push("");
    lines.push(
      "Use these identifiers with the Currents MCP tools (`currents-get-test-results`, `currents-get-spec-instance`, `currents-get-run-details`) for additional context.",
    );

    if (additionalContext) {
      lines.push("");
      lines.push("---");
      lines.push("");
      lines.push("## Recent Failure Context");
      lines.push("");
      lines.push(additionalContext);
    }

    return lines.join("\n");
  }

  private getHtml(webview: vscode.Webview): string {
    const htmlPath = path.join(
      this.extensionUri.fsPath,
      "src",
      "views",
      "testExplorer",
      "testExplorer.html",
    );
    let html = fs.readFileSync(htmlPath, "utf-8");
    html = html.replace(
      "/**__CODICON_CSS__**/",
      getCodiconCss(webview, this.extensionUri),
    );
    return html;
  }
}

function formatDurationForPrompt(ms: number): string {
  if (!ms) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m ${rs}s`;
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
