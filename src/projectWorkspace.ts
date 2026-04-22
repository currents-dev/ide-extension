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

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) {
        return;
      }
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
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

  const scored = await mapWithConcurrency(projects, 5, async (p) => {
    try {
      const res = await client.getProjectRuns(p.projectId, { limit: 1 });
      const created = res.data[0]?.createdAt;
      const latest = created != null ? new Date(created).getTime() : null;
      return { project: p, latest };
    } catch {
      return { project: p, latest: null };
    }
  });

  scored.sort((a, b) => {
    const aTime = a.latest ?? -Infinity;
    const bTime = b.latest ?? -Infinity;
    if (aTime !== bTime) {
      return bTime - aTime;
    }
    return a.project.name.localeCompare(b.project.name);
  });

  const top = scored[0];
  if (top?.latest == null) {
    return undefined;
  }
  return top.project;
}

/** Quick pick (or no-op return when there is a single project). */
export async function pickProjectManually(
  projects: Project[],
): Promise<Project | undefined> {
  if (projects.length === 0) {
    return undefined;
  }
  if (projects.length === 1) {
    return projects[0];
  }
  const pick = await vscode.window.showQuickPick(
    projects.map((p) => ({
      label: p.name,
      description: p.projectId,
      projectId: p.projectId,
    })),
    {
      title: "Select a Currents Project",
      placeHolder: "Choose a project",
    },
  );
  if (!pick) {
    return undefined;
  }
  return projects.find((p) => p.projectId === pick.projectId);
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
    runsProvider.setFilters(
      {
        ...runsProvider.getFilters(),
        branches: [branch],
      },
      { fetch: false },
    );
  }
}
