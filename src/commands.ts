import * as vscode from "vscode";
import { AuthManager } from "./auth.js";
import type { RunFeedItem } from "./api/types.js";
import { RunsWebviewProvider } from "./views/runsWebviewProvider.js";
import { RunDetailPanelProvider } from "./views/runDetailPanel.js";
import { SettingsWebviewProvider } from "./views/settingsWebviewProvider.js";
import type { TestExplorerWebviewProvider } from "./views/testExplorerWebviewProvider.js";
import { getCurrentBranch } from "./git.js";
import { log } from "./log.js";

interface AppState {
  auth: AuthManager;
  runsProvider: RunsWebviewProvider;
  runDetailPanel: RunDetailPanelProvider;
  settingsProvider: SettingsWebviewProvider;
  testExplorerProvider: TestExplorerWebviewProvider;
  context: vscode.ExtensionContext;
}

export function registerCommands(
  state: AppState
): vscode.Disposable[] {
  const { auth, runsProvider, runDetailPanel, settingsProvider, testExplorerProvider, context } = state;

  return [
    vscode.commands.registerCommand("currents.setApiKey", async () => {
      const success = await auth.promptForApiKey();
      if (success) {
        await vscode.commands.executeCommand(
          "setContext",
          "currents.authenticated",
          true
        );
        runsProvider.setClient(auth.client);
        runDetailPanel.setClient(auth.client);
        testExplorerProvider.setClient(auth.client);
        settingsProvider.setHasApiKey(true);
        await vscode.commands.executeCommand("currents.selectProject");
      }
    }),

    vscode.commands.registerCommand(
      "currents.removeApiKey",
      async () => {
        await auth.removeApiKey();
        await vscode.commands.executeCommand(
          "setContext",
          "currents.authenticated",
          false
        );
        await vscode.commands.executeCommand(
          "setContext",
          "currents.projectSelected",
          false
        );
        runsProvider.setClient(undefined);
        runsProvider.setProjectId(undefined);
        testExplorerProvider.setClient(undefined);
        testExplorerProvider.setProjectId(undefined);
        settingsProvider.setHasApiKey(false);
        settingsProvider.setProjectName(undefined);
      }
    ),

    vscode.commands.registerCommand(
      "currents.selectProject",
      async () => {
        if (!auth.client) {
          vscode.window.showWarningMessage(
            "Currents: Please set your API key first."
          );
          return;
        }

        try {
          const { data: allProjects } = await auth.client.getProjects();
          const projects = allProjects.filter(
            (p) => !p.name.toLowerCase().includes("[archived]")
          );
          if (projects.length === 0) {
            vscode.window.showWarningMessage(
              "Currents: No active projects found for this API key."
            );
            return;
          }

          if (projects.length === 1) {
            const project = projects[0];
            context.workspaceState.update(
              "currents.projectId",
              project.projectId
            );
            context.workspaceState.update(
              "currents.projectName",
              project.name
            );
            await vscode.commands.executeCommand(
              "setContext",
              "currents.projectSelected",
              true
            );
            runsProvider.setProjectId(project.projectId);
            testExplorerProvider.setProjectId(project.projectId);
            settingsProvider.setProjectName(project.name);
            await autoSetBranchFilter(runsProvider);
            vscode.window.showInformationMessage(
              `Currents: Selected project "${project.name}"`
            );
            return;
          }

          const pick = await vscode.window.showQuickPick(
            projects.map((p) => ({
              label: p.name,
              description: p.projectId,
              projectId: p.projectId,
            })),
            { title: "Select a Currents Project", placeHolder: "Choose a project" }
          );

          if (pick) {
            context.workspaceState.update(
              "currents.projectId",
              pick.projectId
            );
            context.workspaceState.update(
              "currents.projectName",
              pick.label
            );
            await vscode.commands.executeCommand(
              "setContext",
              "currents.projectSelected",
              true
            );
            runsProvider.setProjectId(pick.projectId);
            testExplorerProvider.setProjectId(pick.projectId);
            settingsProvider.setProjectName(pick.label);
            await autoSetBranchFilter(runsProvider);
            vscode.window.showInformationMessage(
              `Currents: Selected project "${pick.label}"`
            );
          }
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "Unknown error";
          vscode.window.showErrorMessage(
            `Currents: Failed to fetch projects. ${msg}`
          );
        }
      }
    ),

    vscode.commands.registerCommand("currents.refreshRuns", () => {
      runsProvider.setProjectId(
        context.workspaceState.get("currents.projectId")
      );
    }),

    vscode.commands.registerCommand("currents.enableAutoRefresh", () => {
      runsProvider.setAutoRefreshEnabled(true);
    }),

    vscode.commands.registerCommand("currents.disableAutoRefresh", () => {
      runsProvider.setAutoRefreshEnabled(false);
    }),

    vscode.commands.registerCommand("currents.loadMoreRuns", () => {
      runsProvider.loadMore();
    }),

    vscode.commands.registerCommand(
      "currents.filterByBranch",
      async () => {
        const currentFilters = runsProvider.getFilters();
        const currentBranch = await getCurrentBranch();
        const input = await vscode.window.showInputBox({
          title: "Filter by Branch",
          prompt: "Enter branch name (leave empty to clear filter)",
          value:
            currentFilters.branches?.[0] || currentBranch || "",
        });

        if (input === undefined) {
          return;
        }

        runsProvider.setFilters({
          ...currentFilters,
          branches: input ? [input] : undefined,
        });
      }
    ),

    vscode.commands.registerCommand(
      "currents.filterByAuthor",
      async () => {
        const currentFilters = runsProvider.getFilters();
        const input = await vscode.window.showInputBox({
          title: "Filter by Author",
          prompt:
            "Enter author name (leave empty to clear filter)",
          value: currentFilters.authors?.[0] || "",
        });

        if (input === undefined) {
          return;
        }

        runsProvider.setFilters({
          ...currentFilters,
          authors: input ? [input] : undefined,
        });
      }
    ),

    vscode.commands.registerCommand("currents.clearFilters", () => {
      runsProvider.clearFilters();
    }),

    vscode.commands.registerCommand(
      "currents.openRun",
      async (run: RunFeedItem) => {
        log("openRun:", run?.runId);
        await runDetailPanel.openRun(run);
      }
    ),

    vscode.commands.registerCommand(
      "currents.openInDashboard",
      (run?: RunFeedItem) => {
        if (run) {
          const url = `https://app.currents.dev/run/${run.runId}`;
          vscode.env.openExternal(vscode.Uri.parse(url));
        }
      }
    ),

    vscode.commands.registerCommand("currents.refreshTestExplorer", () => {
      testExplorerProvider.setProjectId(
        context.workspaceState.get("currents.projectId")
      );
    }),

    vscode.commands.registerCommand("currents.openTestExplorerInDashboard", () => {
      const projectId = context.workspaceState.get<string>("currents.projectId");
      if (projectId) {
        vscode.env.openExternal(
          vscode.Uri.parse(`https://app.currents.dev/projects/${projectId}/insights/tests`)
        );
      }
    }),

  ];
}

async function autoSetBranchFilter(
  runsProvider: RunsWebviewProvider
): Promise<void> {
  const branch = await getCurrentBranch();
  if (branch) {
    runsProvider.setFilters({ branches: [branch] });
  }
}
