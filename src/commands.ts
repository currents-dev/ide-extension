import * as vscode from "vscode";
import { AuthManager } from "./auth.js";
import type { RunFeedItem } from "./api/types.js";
import { RunsWebviewProvider } from "./views/runs/runsWebviewProvider.js";
import { RunDetailPanelProvider } from "./views/runDetail/runDetailPanel.js";
import { SettingsWebviewProvider } from "./views/settings/settingsWebviewProvider.js";
import type { TestExplorerWebviewProvider } from "./views/testExplorer/testExplorerWebviewProvider.js";
import { log } from "./lib/log.js";
import {
  promptFilterByAuthor,
  promptFilterByBranch,
  promptFilterByStatus,
  promptFilterByTags,
  showRunFiltersMenu,
} from "./runFilterPrompts.js";
import {
  applySelectedProjectToWorkspace,
  fetchActiveProjects,
  pickProjectManually,
} from "./projectWorkspace.js";

interface AppState {
  auth: AuthManager;
  runsProvider: RunsWebviewProvider;
  runDetailPanel: RunDetailPanelProvider;
  settingsProvider: SettingsWebviewProvider;
  testExplorerProvider: TestExplorerWebviewProvider;
  context: vscode.ExtensionContext;
}

export function registerCommands(state: AppState): vscode.Disposable[] {
  const {
    auth,
    runsProvider,
    runDetailPanel,
    settingsProvider,
    testExplorerProvider,
    context,
  } = state;

  return [
    vscode.commands.registerCommand("currents.openSettingsView", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.currents");
      await vscode.commands.executeCommand("currents-settings.focus");
    }),

    vscode.commands.registerCommand("currents.setApiKey", async () => {
      const success = await auth.promptForApiKey();
      if (success) {
        await vscode.commands.executeCommand(
          "setContext",
          "currents.authenticated",
          true,
        );
        runsProvider.setClient(auth.client);
        runDetailPanel.setClient(auth.client);
        testExplorerProvider.setClient(auth.client);
        settingsProvider.setHasApiKey(true);
        await vscode.commands.executeCommand("currents.selectProject");
      }
    }),

    vscode.commands.registerCommand("currents.removeApiKey", async () => {
      await auth.removeApiKey();
      await vscode.commands.executeCommand(
        "setContext",
        "currents.authenticated",
        false,
      );
      await vscode.commands.executeCommand(
        "setContext",
        "currents.projectSelected",
        false,
      );
      runsProvider.setClient(undefined);
      runsProvider.setProjectId(undefined);
      testExplorerProvider.setClient(undefined);
      testExplorerProvider.setProjectId(undefined);
      settingsProvider.setHasApiKey(false);
      settingsProvider.setProjectName(undefined);
    }),

    vscode.commands.registerCommand("currents.selectProject", async () => {
      if (!auth.client) {
        vscode.window.showWarningMessage(
          "Currents: Please set your API key first.",
        );
        return;
      }

      const deps = {
        context,
        runsProvider,
        testExplorerProvider,
        settingsProvider,
      };

      try {
        const projects = await fetchActiveProjects(auth.client);
        if (projects.length === 0) {
          vscode.window.showWarningMessage(
            "Currents: No active projects found for this API key.",
          );
          return;
        }

        const chosen = await pickProjectManually(projects);
        if (chosen) {
          await applySelectedProjectToWorkspace(deps, chosen);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        vscode.window.showErrorMessage(
          `Currents: Failed to fetch projects. ${msg}`,
        );
      }
    }),

    vscode.commands.registerCommand("currents.refreshRuns", () => {
      runsProvider.setProjectId(
        context.workspaceState.get<string>("currents.projectId"),
        context.workspaceState.get<string>("currents.projectName") ??
          undefined,
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

    vscode.commands.registerCommand("currents.filterRuns", async () => {
      await showRunFiltersMenu(runsProvider);
    }),

    vscode.commands.registerCommand("currents.filterByBranch", async () => {
      await promptFilterByBranch(runsProvider);
    }),

    vscode.commands.registerCommand("currents.filterByAuthor", async () => {
      await promptFilterByAuthor(runsProvider);
    }),

    vscode.commands.registerCommand("currents.filterByTags", async () => {
      await promptFilterByTags(runsProvider);
    }),

    vscode.commands.registerCommand("currents.filterByStatus", async () => {
      await promptFilterByStatus(runsProvider);
    }),

    vscode.commands.registerCommand("currents.clearFilters", () => {
      runsProvider.clearFilters();
    }),

    vscode.commands.registerCommand(
      "currents.openRun",
      async (run: RunFeedItem) => {
        log("openRun:", run?.runId);
        await runDetailPanel.openRun(run);
      },
    ),

    vscode.commands.registerCommand(
      "currents.openInDashboard",
      (run?: RunFeedItem) => {
        if (run) {
          const url = `https://app.currents.dev/run/${run.runId}`;
          vscode.env.openExternal(vscode.Uri.parse(url));
        }
      },
    ),

    vscode.commands.registerCommand("currents.refreshTestExplorer", () => {
      testExplorerProvider.setProjectId(
        context.workspaceState.get("currents.projectId"),
      );
    }),

    vscode.commands.registerCommand("currents.changeDateRange", async () => {
      const current = testExplorerProvider.getDateRange();
      const options = [
        { label: "14 days", value: "14d" as const },
        { label: "30 days", value: "30d" as const },
        { label: "60 days", value: "60d" as const },
        { label: "90 days", value: "90d" as const },
      ];
      const pick = await vscode.window.showQuickPick(
        options.map((o) => ({
          label: o.label,
          description: o.value === current ? "$(check) Current" : undefined,
          value: o.value,
        })),
        { title: "Select Date Range" },
      );
      if (pick) {
        testExplorerProvider.setDateRange(pick.value);
      }
    }),

    vscode.commands.registerCommand(
      "currents.openTestExplorerInDashboard",
      () => {
        const projectId =
          context.workspaceState.get<string>("currents.projectId");
        if (projectId) {
          vscode.env.openExternal(
            vscode.Uri.parse(
              `https://app.currents.dev/projects/${projectId}/insights/tests`,
            ),
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "currents.analyzeTest",
      async (testName: string, filePath: string) => {
        const relativePath =
          vscode.workspace.asRelativePath(filePath) || filePath;

        const prompt = [
          `Use the Currents MCP tools to analyze the test **"${testName}"** defined in \`${relativePath}\`.`,
          "",
          "Please:",
          "1. Use `currents-get-tests-signatures` with the spec file path and test title to get the test signature, then use `currents-get-test-results` to find recent run data",
          "2. Check if there were any failures in recent runs",
          "3. Determine if the test is flaky (intermittent pass/fail pattern)",
          "4. Check if the test is slow compared to the suite average",
          "5. If there are any issues (failures, flakiness, or performance), build a concrete plan to fix them",
          "",
          "If everything looks healthy, just confirm the test is in good shape.",
        ].join("\n");

        try {
          await vscode.commands.executeCommand(
            "workbench.action.chat.open",
            { query: prompt },
          );
        } catch {
          await vscode.env.clipboard.writeText(prompt);
          vscode.window.showInformationMessage(
            "Currents: Prompt copied to clipboard. Paste it in the AI chat.",
          );
        }
      },
    ),
  ];
}
