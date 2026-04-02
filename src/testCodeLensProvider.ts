import * as vscode from "vscode";

const TEST_KEYWORD =
  /\b(?:describe|test|it|context)(?:\.(?:only|skip|todo|each|concurrent))*\s*\(\s*$/;

const TEST_NAME_INLINE =
  /\b(?:describe|test|it|context)(?:\.(?:only|skip|todo|each|concurrent))*\s*\(\s*(['"`])((?:(?!\1).)*)\1/;

const STRING_START = /^\s*(['"`])((?:(?!\1).)*)\1/;

const SUPPORTED_LANGUAGES: vscode.DocumentSelector = [
  { language: "javascript" },
  { language: "typescript" },
  { language: "javascriptreact" },
  { language: "typescriptreact" },
];

const MAX_LOOKAHEAD = 3;

function isAlwaysVisible(): boolean {
  return (
    vscode.workspace
      .getConfiguration("currents")
      .get<string>("analyzeTestDisplay", "always") === "always"
  );
}

function matchTestName(
  document: vscode.TextDocument,
  lineIndex: number,
): string | undefined {
  const lineText = document.lineAt(lineIndex).text;

  const inlineMatch = lineText.match(TEST_NAME_INLINE);
  if (inlineMatch) {
    return inlineMatch[2];
  }

  if (!TEST_KEYWORD.test(lineText)) {
    return undefined;
  }

  for (
    let j = 1;
    j <= MAX_LOOKAHEAD && lineIndex + j < document.lineCount;
    j++
  ) {
    const nextText = document.lineAt(lineIndex + j).text;
    const m = nextText.match(STRING_START);
    if (m) {
      return m[2];
    }
    if (nextText.trim().length > 0) {
      break;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// CodeLens – shows on every test line (when "always")
// ---------------------------------------------------------------------------

class TestCodeLensProvider implements vscode.CodeLensProvider {
  private _onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onChange.event;

  refresh(): void {
    this._onChange.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isAlwaysVisible()) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];
    for (let i = 0; i < document.lineCount; i++) {
      const testName = matchTestName(document, i);
      if (testName) {
        lenses.push(
          new vscode.CodeLens(document.lineAt(i).range, {
            title: "$(sparkle) Analyze with Currents",
            command: "currents.analyzeTest",
            arguments: [testName, document.uri.fsPath],
          }),
        );
      }
    }
    return lenses;
  }
}

// ---------------------------------------------------------------------------
// Code Action – always registered (Quick Fix: Ctrl+. / Cmd+.)
// ---------------------------------------------------------------------------

class TestCodeActionProvider implements vscode.CodeActionProvider {
  static readonly kind = vscode.CodeActionKind.QuickFix.append("currents");

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): vscode.CodeAction[] {
    const testName = matchTestName(document, range.start.line);
    if (!testName) {
      return [];
    }

    const action = new vscode.CodeAction(
      "Analyze with Currents",
      TestCodeActionProvider.kind,
    );
    action.command = {
      title: "Analyze with Currents",
      command: "currents.analyzeTest",
      arguments: [testName, document.uri.fsPath],
    };
    action.isPreferred = true;
    return [action];
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTestAnalysis(): vscode.Disposable {
  const codeLens = new TestCodeLensProvider();

  const codeLensReg = vscode.languages.registerCodeLensProvider(
    SUPPORTED_LANGUAGES,
    codeLens,
  );

  const codeActionReg = vscode.languages.registerCodeActionsProvider(
    SUPPORTED_LANGUAGES,
    new TestCodeActionProvider(),
    { providedCodeActionKinds: [TestCodeActionProvider.kind] },
  );

  const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("currents.analyzeTestDisplay")) {
      codeLens.refresh();
    }
  });

  return vscode.Disposable.from(codeLensReg, codeActionReg, configSub);
}
