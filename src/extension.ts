import * as vscode from "vscode";
import { AuthManager } from "./auth.js";
import { RunsWebviewProvider } from "./views/runsWebviewProvider.js";
import { RunDetailPanelProvider } from "./views/runDetailPanel.js";
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

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      RunsWebviewProvider.viewType,
      runsProvider
    )
  );

  context.subscriptions.push(auth);

  const commands = registerCommands({
    auth,
    runsProvider,
    runDetailPanel,
    context,
  });
  context.subscriptions.push(...commands);

  const authenticated = await auth.initialize();
  await vscode.commands.executeCommand(
    "setContext",
    "currents.authenticated",
    authenticated
  );

  if (authenticated) {
    runsProvider.setClient(auth.client);
    runDetailPanel.setClient(auth.client);

    const savedProjectId = context.workspaceState.get<string>(
      "currents.projectId"
    );
    if (savedProjectId) {
      await vscode.commands.executeCommand(
        "setContext",
        "currents.projectSelected",
        true
      );
      runsProvider.setProjectId(savedProjectId);

      const branch = await getCurrentBranch();
      if (branch) {
        runsProvider.setFilters({ branches: [branch] });
      }
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
