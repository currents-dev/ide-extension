import * as vscode from "vscode";
import { CurrentsApiClient } from "./api/client.js";

const SECRET_KEY = "currents.apiKey";

export class AuthManager {
  private readonly _onDidChangeAuth = new vscode.EventEmitter<boolean>();
  readonly onDidChangeAuth = this._onDidChangeAuth.event;

  private secrets: vscode.SecretStorage;
  private _client: CurrentsApiClient | undefined;

  constructor(secrets: vscode.SecretStorage) {
    this.secrets = secrets;
  }

  get client(): CurrentsApiClient | undefined {
    return this._client;
  }

  private static getBaseUrl(): string | undefined {
    return vscode.workspace
      .getConfiguration("currents")
      .get<string>("apiBaseUrl") || undefined;
  }

  async initialize(): Promise<boolean> {
    const key = await this.secrets.get(SECRET_KEY);
    if (key) {
      this._client = new CurrentsApiClient(key, AuthManager.getBaseUrl());
      return true;
    }
    return false;
  }

  async promptForApiKey(): Promise<boolean> {
    const key = await vscode.window.showInputBox({
      title: "Currents API Key",
      prompt: "Enter your Currents.dev API key",
      password: true,
      placeHolder: "Paste your API key here",
      ignoreFocusOut: true,
    });

    if (!key) {
      return false;
    }

    const tempClient = new CurrentsApiClient(key, AuthManager.getBaseUrl());
    try {
      await tempClient.getProjects(1);
    } catch {
      vscode.window.showErrorMessage(
        "Invalid API key. Please check your key and try again."
      );
      return false;
    }

    await this.secrets.store(SECRET_KEY, key);
    this._client = tempClient;
    this._onDidChangeAuth.fire(true);
    vscode.window.showInformationMessage("Currents: API key saved successfully.");
    return true;
  }

  async removeApiKey(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    this._client = undefined;
    this._onDidChangeAuth.fire(false);
    vscode.window.showInformationMessage("Currents: API key removed.");
  }

  get isAuthenticated(): boolean {
    return this._client !== undefined;
  }

  dispose(): void {
    this._onDidChangeAuth.dispose();
  }
}
