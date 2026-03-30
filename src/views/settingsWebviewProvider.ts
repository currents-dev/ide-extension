import * as vscode from "vscode";

export class SettingsWebviewProvider
  implements vscode.WebviewViewProvider
{
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
        case "setApiKey":
          vscode.commands.executeCommand("currents.setApiKey");
          break;
        case "removeApiKey":
          vscode.commands.executeCommand("currents.removeApiKey");
          break;
        case "toggleNotifications":
          this.setNotificationsEnabled(message.enabled);
          break;
        case "selectProject":
          vscode.commands.executeCommand("currents.selectProject");
          break;
        case "setApiBaseUrl":
          this.setApiBaseUrl(message.url);
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
      notificationsEnabled: SettingsWebviewProvider.getNotificationsEnabled(),
      apiBaseUrl: SettingsWebviewProvider.getApiBaseUrl(),
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

  static getApiBaseUrl(): string {
    return vscode.workspace
      .getConfiguration("currents")
      .get<string>("apiBaseUrl", "https://api.currents.dev/v1");
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
    padding: 8px 12px;
  }

  .section {
    margin-bottom: 20px;
  }
  .section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 10px;
  }
  .section-content {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .key-status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    margin-bottom: 4px;
  }
  .key-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .key-dot.connected { background: var(--vscode-testing-iconPassed); }
  .key-dot.disconnected { background: var(--vscode-testing-iconFailed); }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 6px 12px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-family: var(--vscode-font-family);
    width: 100%;
  }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-primary:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .btn-danger {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-errorForeground);
  }
  .btn-danger:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 0;
  }
  .toggle-label {
    font-size: 12px;
    line-height: 1.4;
  }
  .toggle-desc {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-top: 2px;
  }

  .toggle-switch {
    position: relative;
    width: 36px;
    height: 20px;
    flex-shrink: 0;
  }
  .toggle-switch input {
    opacity: 0;
    width: 0;
    height: 0;
  }
  .toggle-slider {
    position: absolute;
    cursor: pointer;
    top: 0; left: 0; right: 0; bottom: 0;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
    border-radius: 10px;
    transition: background 0.2s;
  }
  .toggle-slider::before {
    content: '';
    position: absolute;
    height: 14px;
    width: 14px;
    left: 2px;
    bottom: 2px;
    background: var(--vscode-foreground);
    border-radius: 50%;
    transition: transform 0.2s;
  }
  input:checked + .toggle-slider {
    background: var(--vscode-button-background);
    border-color: var(--vscode-button-background);
  }
  input:checked + .toggle-slider::before {
    transform: translateX(16px);
    background: var(--vscode-button-foreground);
  }

  .text-input {
    width: 100%;
    padding: 5px 8px;
    font-size: 12px;
    font-family: var(--vscode-font-family);
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
    border-radius: 4px;
    outline: none;
  }
  .text-input:focus {
    border-color: var(--vscode-focusBorder);
  }
  .input-desc {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-top: 4px;
  }
</style>
</head>
<body>
  <div class="section">
    <div class="section-title">API Key</div>
    <div class="section-content">
      <div class="key-status">
        <span class="key-dot" id="key-dot"></span>
        <span id="key-label">Checking…</span>
      </div>
      <button class="btn btn-primary" id="set-key-btn">Set API Key</button>
      <button class="btn btn-danger" id="remove-key-btn" style="display:none">Remove API Key</button>
    </div>
  </div>

  <div class="section" id="project-section" style="display:none">
    <div class="section-title">Project</div>
    <div class="section-content">
      <div class="key-status">
        <span class="key-dot" id="project-dot"></span>
        <span id="project-label">No project selected</span>
      </div>
      <button class="btn btn-primary" id="select-project-btn">Select Project</button>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Notifications</div>
    <div class="section-content">
      <div class="toggle-row">
        <div>
          <div class="toggle-label">Run completed</div>
          <div class="toggle-desc">Show a notification when a run finishes</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="notify-toggle">
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">API Base URL</div>
    <div class="section-content">
      <input type="text" class="text-input" id="api-base-url" placeholder="https://api.currents.dev/v1">
      <div class="input-desc">Change this only if you use a custom Currents API endpoint.</div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    const keyDot = document.getElementById('key-dot');
    const keyLabel = document.getElementById('key-label');
    const setKeyBtn = document.getElementById('set-key-btn');
    const removeKeyBtn = document.getElementById('remove-key-btn');
    const projectSection = document.getElementById('project-section');
    const projectDot = document.getElementById('project-dot');
    const projectLabel = document.getElementById('project-label');
    const selectProjectBtn = document.getElementById('select-project-btn');
    const notifyToggle = document.getElementById('notify-toggle');
    const apiBaseUrlInput = document.getElementById('api-base-url');

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'state') {
        updateUi(msg);
      }
    });

    function updateUi(state) {
      if (state.hasApiKey) {
        keyDot.className = 'key-dot connected';
        keyLabel.textContent = 'Connected';
        setKeyBtn.textContent = 'Change API Key';
        removeKeyBtn.style.display = '';
      } else {
        keyDot.className = 'key-dot disconnected';
        keyLabel.textContent = 'Not configured';
        setKeyBtn.textContent = 'Set API Key';
        removeKeyBtn.style.display = 'none';
      }
      // Project section — only visible when authenticated
      if (state.hasApiKey) {
        projectSection.style.display = '';
        if (state.projectName) {
          projectDot.className = 'key-dot connected';
          projectLabel.textContent = state.projectName;
          selectProjectBtn.textContent = 'Change Project';
        } else {
          projectDot.className = 'key-dot disconnected';
          projectLabel.textContent = 'No project selected';
          selectProjectBtn.textContent = 'Select Project';
        }
      } else {
        projectSection.style.display = 'none';
      }

      notifyToggle.checked = !!state.notificationsEnabled;

      if (document.activeElement !== apiBaseUrlInput) {
        apiBaseUrlInput.value = state.apiBaseUrl || '';
      }
    }

    setKeyBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'setApiKey' });
    });

    removeKeyBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'removeApiKey' });
    });

    selectProjectBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'selectProject' });
    });

    notifyToggle.addEventListener('change', () => {
      vscode.postMessage({ type: 'toggleNotifications', enabled: notifyToggle.checked });
    });

    var baseUrlTimeout;
    apiBaseUrlInput.addEventListener('input', () => {
      clearTimeout(baseUrlTimeout);
      baseUrlTimeout = setTimeout(() => {
        vscode.postMessage({ type: 'setApiBaseUrl', url: apiBaseUrlInput.value });
      }, 600);
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
