import * as vscode from "vscode";
import { AuthManager } from "./auth.js";
import { RunsWebviewProvider } from "./views/runs/runsWebviewProvider.js";
import { RunDetailPanelProvider } from "./views/runDetail/runDetailPanel.js";
import { SettingsWebviewProvider } from "./views/settings/settingsWebviewProvider.js";
import { TestExplorerWebviewProvider } from "./views/testExplorer/testExplorerWebviewProvider.js";
import { registerCommands } from "./commands.js";
import { getCurrentBranch } from "./lib/git.js";
import { initLog, log } from "./lib/log.js";
import {
  applySelectedProjectToWorkspace,
  fetchActiveProjects,
  pickProjectManually,
  pickProjectWithLatestRun,
} from "./projectWorkspace.js";
import { initMcpServer } from "./mcp.js";
import { registerTestAnalysis } from "./testCodeLensProvider.js";

export async function activate(
  context: vscode.ExtensionContext,
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
  const testExplorerProvider = new TestExplorerWebviewProvider(
    context.extensionUri,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      RunsWebviewProvider.viewType,
      runsProvider,
    ),
    vscode.window.registerWebviewViewProvider(
      TestExplorerWebviewProvider.viewType,
      testExplorerProvider,
    ),
    vscode.window.registerWebviewViewProvider(
      SettingsWebviewProvider.viewType,
      settingsProvider,
    ),
  );

  context.subscriptions.push(auth);
  context.subscriptions.push(registerTestAnalysis());

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
    authenticated,
  );

  settingsProvider.setHasApiKey(authenticated);
  context.subscriptions.push(initMcpServer(auth, context.secrets));

  if (authenticated) {
    runsProvider.setClient(auth.client);
    runDetailPanel.setClient(auth.client);
    testExplorerProvider.setClient(auth.client);

    const savedProjectId =
      context.workspaceState.get<string>("currents.projectId");
    const savedProjectName = context.workspaceState.get<string>(
      "currents.projectName",
    );
    settingsProvider.setProjectName(savedProjectName);

    if (savedProjectId) {
      await vscode.commands.executeCommand(
        "setContext",
        "currents.projectSelected",
        true,
      );

      if (SettingsWebviewProvider.getFilterByCurrentBranch()) {
        const branch = await getCurrentBranch();
        if (branch) {
          runsProvider.setFilters({ branches: [branch] });
        }
      }
      runsProvider.setProjectId(
        savedProjectId,
        savedProjectName ?? undefined,
      );
      testExplorerProvider.setProjectId(savedProjectId);
    } else {
      const projectDeps = {
        context,
        runsProvider,
        testExplorerProvider,
        settingsProvider,
      };
      const applyIfChosen = async (
        project: { projectId: string; name: string },
      ) => {
        await applySelectedProjectToWorkspace(projectDeps, project, {
          showToast: false,
        });
      };
      const clearProjectContext = () =>
        vscode.commands.executeCommand(
          "setContext",
          "currents.projectSelected",
          false,
        );
      try {
        const projects = await fetchActiveProjects(auth.client!);
        let chosen = await pickProjectWithLatestRun(auth.client!, projects);
        if (!chosen && projects.length > 0) {
          chosen = await pickProjectManually(projects);
        }
        if (chosen) {
          await applyIfChosen(chosen);
        } else {
          await clearProjectContext();
        }
      } catch (err) {
        log("Currents: auto-select default project failed:", err);
        try {
          const projects = await fetchActiveProjects(auth.client!);
          const manual = await pickProjectManually(projects);
          if (manual) {
            await applyIfChosen(manual);
          } else {
            await clearProjectContext();
          }
        } catch (err2) {
          log("Currents: manual project pick after auto failure failed:", err2);
          await clearProjectContext();
        }
      }
    }
  }
}

export function deactivate() {}
