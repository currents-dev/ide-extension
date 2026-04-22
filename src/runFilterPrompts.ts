import * as vscode from "vscode";
import type { RunFeedApiStatus } from "./api/types.js";
import { getCurrentBranch } from "./lib/git.js";
import type { RunsWebviewProvider } from "./views/runs/runsWebviewProvider.js";

export async function promptFilterByBranch(
  runsProvider: RunsWebviewProvider,
): Promise<void> {
  const currentFilters = runsProvider.getFilters();
  const currentBranch = await getCurrentBranch();
  const input = await vscode.window.showInputBox({
    title: "Filter by Branch",
    prompt: "Enter branch name (leave empty to clear filter)",
    value: currentFilters.branches?.[0] || currentBranch || "",
  });

  if (input === undefined) {
    return;
  }

  runsProvider.setFilters({
    ...currentFilters,
    branches: input ? [input] : undefined,
  });
}

export async function promptFilterByAuthor(
  runsProvider: RunsWebviewProvider,
): Promise<void> {
  const currentFilters = runsProvider.getFilters();
  const input = await vscode.window.showInputBox({
    title: "Filter by Author",
    prompt: "Enter author name (leave empty to clear filter)",
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

export async function promptFilterByTags(
  runsProvider: RunsWebviewProvider,
): Promise<void> {
  const currentFilters = runsProvider.getFilters();
  const input = await vscode.window.showInputBox({
    title: "Filter by Tags",
    prompt:
      "Comma-separated tags (empty clears). With 2+ tags you choose AND vs OR next.",
    value: currentFilters.tags?.join(", ") ?? "",
  });

  if (input === undefined) {
    return;
  }

  const parts = input
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  let tagOperator = currentFilters.tagOperator;
  if (parts.length > 1) {
    const opPick = await vscode.window.showQuickPick(
      [
        {
          label: "All tags (AND)",
          description: "Run must include every tag",
          value: "AND" as const,
        },
        {
          label: "Any tag (OR)",
          description: "Run must include at least one tag",
          value: "OR" as const,
        },
      ],
      { title: "Match tags using", placeHolder: "How to combine tags" },
    );
    if (opPick === undefined) {
      return;
    }
    tagOperator = opPick.value;
  } else {
    tagOperator = undefined;
  }

  runsProvider.setFilters({
    ...currentFilters,
    tags: parts.length ? parts : undefined,
    tagOperator: parts.length > 1 ? tagOperator ?? "AND" : undefined,
  });
}

export async function promptFilterByStatus(
  runsProvider: RunsWebviewProvider,
): Promise<void> {
  const currentFilters = runsProvider.getFilters();
  type StatusPick = vscode.QuickPickItem & { api: RunFeedApiStatus };
  const items: StatusPick[] = [
    {
      label: "Passed",
      api: "PASSED",
      picked: currentFilters.status?.includes("PASSED"),
    },
    {
      label: "Failed",
      api: "FAILED",
      picked: currentFilters.status?.includes("FAILED"),
    },
    {
      label: "Running",
      api: "RUNNING",
      picked: currentFilters.status?.includes("RUNNING"),
    },
    {
      label: "Failing",
      api: "FAILING",
      picked: currentFilters.status?.includes("FAILING"),
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: "Filter by run status",
    canPickMany: true,
    placeHolder: "Select one or more (none clears)",
  });

  if (picked === undefined) {
    return;
  }

  runsProvider.setFilters({
    ...currentFilters,
    status: picked.length ? picked.map((p) => p.api) : undefined,
  });
}

type FilterMenuItem = vscode.QuickPickItem & { id: string };

export async function showRunFiltersMenu(
  runsProvider: RunsWebviewProvider,
): Promise<void> {
  const items: FilterMenuItem[] = [
    {
      label: "$(git-branch) Branch",
      description: "Filter runs by git branch",
      id: "branch",
    },
    {
      label: "$(person) Author",
      description: "Filter by commit author",
      id: "author",
    },
    {
      label: "$(tag) Tags",
      description: "Comma-separated; AND/OR for multiple",
      id: "tags",
    },
    {
      label: "$(run) Status",
      description: "Passed, failed, running, failing",
      id: "status",
    },
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: "Filter runs",
    placeHolder: "Choose filter type",
  });

  if (!pick) {
    return;
  }

  switch (pick.id) {
    case "branch":
      await promptFilterByBranch(runsProvider);
      break;
    case "author":
      await promptFilterByAuthor(runsProvider);
      break;
    case "tags":
      await promptFilterByTags(runsProvider);
      break;
    case "status":
      await promptFilterByStatus(runsProvider);
      break;
    default:
      break;
  }
}
