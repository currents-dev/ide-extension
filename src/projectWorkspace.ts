import * as vscode from "vscode";
import type { CurrentsApiClient } from "./api/client.js";
import type { Project } from "./api/types.js";
import { getCurrentBranch } from "./lib/git.js";
import { RunsWebviewProvider } from "./views/runs/runsWebviewProvider.js";
import { SettingsWebviewProvider } from "./views/settings/settingsWebviewProvider.js";
import type { TestExplorerWebviewProvider } from "./views/testExplorer/testExplorerWebviewProvider.js";

export interface ProjectSelectionDeps {
  context: vscode.ExtensionContext;
  runsProvider: RunsWebviewProvider;
  testExplorerProvider: TestExplorerWebviewProvider;
  settingsProvider: SettingsWebviewProvider;
}

export function filterActiveProjects(all: Project[]): Project[] {
  return all.filter((p) => !p.name.toLowerCase().includes("[archived]"));
}

export async function fetchActiveProjects(
  client: CurrentsApiClient,
): Promise<Project[]> {
  const { data: allProjects } = await client.getProjects({ fetchAll: true });
  return filterActiveProjects(allProjects);
}

/** Picks project whose latest run is most recent (GET runs with limit 1 per project). */
export async function pickProjectWithLatestRun(
  client: CurrentsApiClient,
  projects: Project[],
): Promise<Project | undefined> {
  if (projects.length === 0) {
    return undefined;
  }
  if (projects.length === 1) {
    return projects[0];
  }

  const scored = await Promise.all(
    projects.map(async (p) => {
      try {
        const res = await client.getProjectRuns(p.projectId, { limit: 1 });
        const created = res.data[0]?.createdAt;
        const latest = created ? new Date(created).getTime() : 0;
        return { project: p, latest };
      } catch {
        return { project: p, latest: 0 };
      }
    }),
  );

  scored.sort((a, b) => {
    if (b.latest !== a.latest) {
      return b.latest - a.latest;
    }
    return a.project.name.localeCompare(b.project.name);
  });

  return scored[0]?.project;
}

export async function applySelectedProjectToWorkspace(
  deps: ProjectSelectionDeps,
  project: { projectId: string; name: string },
  options?: { showToast?: boolean },
): Promise<void> {
  const { context, runsProvider, testExplorerProvider, settingsProvider } =
    deps;
  await context.workspaceState.update("currents.projectId", project.projectId);
  await context.workspaceState.update("currents.projectName", project.name);
  await vscode.commands.executeCommand(
    "setContext",
    "currents.projectSelected",
    true,
  );
  settingsProvider.setProjectName(project.name);
  await autoSetBranchFilter(runsProvider);
  runsProvider.setProjectId(project.projectId, project.name);
  testExplorerProvider.setProjectId(project.projectId);
  if (options?.showToast ?? true) {
    vscode.window.showInformationMessage(
      `Currents: Selected project "${project.name}"`,
    );
  }
}

async function autoSetBranchFilter(
  runsProvider: RunsWebviewProvider,
): Promise<void> {
  const enabled = vscode.workspace
    .getConfiguration("currents")
    .get<boolean>("filterByCurrentBranch", false);
  if (!enabled) {
    return;
  }
  const branch = await getCurrentBranch();
  if (branch) {
    runsProvider.setFiltersSilently({
      ...runsProvider.getFilters(),
      branches: [branch],
    });
  }
}
