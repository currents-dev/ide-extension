import * as vscode from "vscode";
import { execFile } from "child_process";

export async function getCurrentBranch(): Promise<string | undefined> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    return undefined;
  }

  const cwd = workspaceFolders[0].uri.fsPath;

  return new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd },
      (err, stdout) => {
        if (err) {
          resolve(undefined);
          return;
        }
        const branch = stdout.trim();
        resolve(branch || undefined);
      }
    );
  });
}
