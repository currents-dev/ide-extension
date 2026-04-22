import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export class SettingsWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "currents-settings";

  private view?: vscode.WebviewView;
  private hasApiKey = false;
  private projectName: string | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setHasApiKey(value: boolean): void {
    this.hasApiKey = value;
    this.sendState();
  }

  setProjectName(name: string | undefined): void {
    this.projectName = name;
    this.sendState();
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

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.type) {
        case "ready":
          this.sendState();
          break;
        case "setApiKey":
          vscode.commands.executeCommand("currents.setApiKey");
          break;
        case "removeApiKey":
          vscode.commands.executeCommand("currents.removeApiKey");
          break;
        case "toggleNotifications":
          this.setNotificationsEnabled(message.enabled);
          break;
        case "toggleBranchFilter":
          this.setFilterByCurrentBranch(message.enabled);
          break;
        case "selectProject":
          vscode.commands.executeCommand("currents.selectProject");
          break;
        case "setApiBaseUrl":
          this.setApiBaseUrl(message.url);
          break;
        case "setAnalyzeTestDisplay":
          this.setAnalyzeTestDisplay(message.value);
          break;
        case "toggleExperimentalAiContextFetch":
          this.setExperimentalAiContextFetch(message.enabled);
          break;
      }
    });
  }

  private sendState(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({
      type: "state",
      hasApiKey: this.hasApiKey,
      projectName: this.projectName,
      filterByCurrentBranch: SettingsWebviewProvider.getFilterByCurrentBranch(),
      notificationsEnabled: SettingsWebviewProvider.getNotificationsEnabled(),
      apiBaseUrl: SettingsWebviewProvider.getApiBaseUrl(),
      analyzeTestDisplay: SettingsWebviewProvider.getAnalyzeTestDisplay(),
      experimentalAiContextFetch:
        SettingsWebviewProvider.getExperimentalAiContextFetch(),
      quickFixKeybinding: process.platform === "darwin" ? "⌘." : "Ctrl+.",
    });
  }

  private async setNotificationsEnabled(enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration("currents");
    await config.update("notifyOnRunComplete", enabled, true);
    this.sendState();
  }

  static getNotificationsEnabled(): boolean {
    return vscode.workspace
      .getConfiguration("currents")
      .get<boolean>("notifyOnRunComplete", false);
  }

  static getFilterByCurrentBranch(): boolean {
    return vscode.workspace
      .getConfiguration("currents")
      .get<boolean>("filterByCurrentBranch", false);
  }

  static getApiBaseUrl(): string {
    return vscode.workspace
      .getConfiguration("currents")
      .get<string>("apiBaseUrl", "https://api.currents.dev/v1");
  }

  private async setFilterByCurrentBranch(enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration("currents");
    await config.update("filterByCurrentBranch", enabled, true);
    this.sendState();
  }

  static getAnalyzeTestDisplay(): string {
    return vscode.workspace
      .getConfiguration("currents")
      .get<string>("analyzeTestDisplay", "always");
  }

  private async setAnalyzeTestDisplay(value: string): Promise<void> {
    const config = vscode.workspace.getConfiguration("currents");
    await config.update("analyzeTestDisplay", value, true);
    this.sendState();
  }

  static getExperimentalAiContextFetch(): boolean {
    return vscode.workspace
      .getConfiguration("currents")
      .get<boolean>("experimental.aiContextFetch", false);
  }

  private async setExperimentalAiContextFetch(enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration("currents");
    await config.update("experimental.aiContextFetch", enabled, true);
    this.sendState();
  }

  private async setApiBaseUrl(url: string): Promise<void> {
    const config = vscode.workspace.getConfiguration("currents");
    const trimmed = url.trim();
    if (trimmed && trimmed !== "https://api.currents.dev/v1") {
      await config.update("apiBaseUrl", trimmed, true);
    } else {
      await config.update("apiBaseUrl", undefined, true);
    }
    this.sendState();
  }

  private getHtml(): string {
    const htmlPath = path.join(
      this.extensionUri.fsPath,
      "src",
      "views",
      "settings",
      "settings.html",
    );
    return fs.readFileSync(htmlPath, "utf-8");
  }
}
