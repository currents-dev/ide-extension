import * as vscode from "vscode";

const GLYPHS: Record<string, string> = {
  "go-to-file": "\\ea94",
  bug: "\\eaaf",
  "link-external": "\\eb14",
  globe: "\\eb01",
  sparkle: "\\ec10",
  "chat-sparkle": "\\ec4f",
  forward: "\\ec73",
  "chevron-down": "\\eab4",
  "chevron-right": "\\eab6",
};

export function getCodiconCss(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const fontUri = webview.asWebviewUri(
    vscode.Uri.joinPath(
      extensionUri,
      "node_modules",
      "@vscode",
      "codicons",
      "dist",
      "codicon.ttf",
    ),
  );

  const glyphRules = Object.entries(GLYPHS)
    .map(([name, code]) => `.codicon-${name}:before { content: "${code}"; }`)
    .join("\n");

  return `@font-face {
  font-family: "codicon";
  font-display: block;
  src: url("${fontUri}") format("truetype");
}
.codicon {
  font: normal normal normal 16px/1 codicon;
  display: inline-block;
  text-decoration: none;
  text-rendering: auto;
  text-align: center;
  vertical-align: text-bottom;
  -webkit-font-smoothing: antialiased;
}
${glyphRules}`;
}
