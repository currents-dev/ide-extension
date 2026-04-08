import * as vscode from "vscode";

/** Experimental: `currents.experimental.aiContextFetch` in Settings. */
export function isAiContextFetchEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("currents")
    .get<boolean>("experimental.aiContextFetch", false);
}
