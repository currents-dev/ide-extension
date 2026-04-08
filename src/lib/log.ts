import * as vscode from "vscode";

let channel: vscode.OutputChannel;

export function initLog(): vscode.OutputChannel {
  channel = vscode.window.createOutputChannel("Currents");
  return channel;
}

export function log(...args: unknown[]): void {
  const msg = args
    .map((a) =>
      typeof a === "string" ? a : JSON.stringify(a, null, 2)
    )
    .join(" ");
  const ts = new Date().toISOString().slice(11, 23);
  channel.appendLine(`[${ts}] ${msg}`);
}
