import * as vscode from "vscode";
import { AuthManager } from "./auth.js";
import { RunsWebviewProvider } from "./views/runsWebviewProvider.js";
import { RunDetailPanelProvider } from "./views/runDetailPanel.js";
import { SettingsWebviewProvider } from "./views/settingsWebviewProvider.js";
import { TestExplorerWebviewProvider } from "./views/testExplorerWebviewProvider.js";
import { registerCommands } from "./commands.js";
import { getCurrentBranch } from "./git.js";
import { initLog, log } from "./log.js";

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  const logChannel = initLog();
  context.subscriptions.push(logChannel);
  log("Currents extension activating");

  const auth = new AuthManager(context.secrets);
  const runsProvider = new RunsWebviewProvider(context.extensionUri);
  const runDetailPanel = new RunDetailPanelProvider(context.extensionUri);
  runDetailPanel.onActiveRunChanged = (runId) => {
    runsProvider.setActiveRunId(runId);
  };
  const settingsProvider = new SettingsWebviewProvider(context.extensionUri);
  const testExplorerProvider = new TestExplorerWebviewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      RunsWebviewProvider.viewType,
      runsProvider
    ),
    vscode.window.registerWebviewViewProvider(
      TestExplorerWebviewProvider.viewType,
      testExplorerProvider
    ),
    vscode.window.registerWebviewViewProvider(
      SettingsWebviewProvider.viewType,
      settingsProvider
    )
  );

  context.subscriptions.push(auth);

  const commands = registerCommands({
    auth,
    runsProvider,
    runDetailPanel,
    settingsProvider,
    testExplorerProvider,
    context,
  });
  context.subscriptions.push(...commands);

  const authenticated = await auth.initialize();
  await vscode.commands.executeCommand(
    "setContext",
    "currents.authenticated",
    authenticated
  );

  settingsProvider.setHasApiKey(authenticated);

  if (authenticated) {
    runsProvider.setClient(auth.client);
    runDetailPanel.setClient(auth.client);
    testExplorerProvider.setClient(auth.client);

    const savedProjectId = context.workspaceState.get<string>(
      "currents.projectId"
    );
    const savedProjectName = context.workspaceState.get<string>(
      "currents.projectName"
    );
    settingsProvider.setProjectName(savedProjectName);

    if (savedProjectId) {
      await vscode.commands.executeCommand(
        "setContext",
        "currents.projectSelected",
        true
      );

      const branch = await getCurrentBranch();
      if (branch) {
        runsProvider.setFilters({ branches: [branch] });
      }
      runsProvider.setProjectId(savedProjectId);
      testExplorerProvider.setProjectId(savedProjectId);
    } else {
      await vscode.commands.executeCommand(
        "setContext",
        "currents.projectSelected",
        false
      );
    }
  }
}

export function deactivate() {}
