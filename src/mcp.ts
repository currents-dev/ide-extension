import * as vscode from "vscode";
import type { AuthManager } from "./auth.js";
import { log } from "./log.js";

const SERVER_NAME = "currents";
const SECRET_KEY = "currents.apiKey";

function isEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("currents")
    .get<boolean>("registerMcpServer", true);
}

/**
 * Initializes MCP server registration for both VS Code and Cursor.
 * The server is registered when an API key is present and the
 * `currents.registerMcpServer` setting is enabled.
 */
export function initMcpServer(
  auth: AuthManager,
  secrets: vscode.SecretStorage,
): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];

  const vsCodeDisposable = tryRegisterVSCode(auth, secrets);
  if (vsCodeDisposable) {
    disposables.push(vsCodeDisposable);
  }

  const cursorCleanup = tryRegisterCursor(auth, secrets);
  if (cursorCleanup) {
    disposables.push(cursorCleanup);
  }

  return vscode.Disposable.from(...disposables);
}

// ---------------------------------------------------------------------------
// VS Code: provider-based registration
// ---------------------------------------------------------------------------

function tryRegisterVSCode(
  auth: AuthManager,
  secrets: vscode.SecretStorage,
): vscode.Disposable | undefined {
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== "function") {
    log(
      "MCP: vscode.lm.registerMcpServerDefinitionProvider not available, skipping VS Code registration",
    );
    return undefined;
  }

  const didChange = new vscode.EventEmitter<void>();

  const authSub = auth.onDidChangeAuth(() => didChange.fire());
  const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("currents.registerMcpServer")) {
      didChange.fire();
    }
  });

  const provider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> =
    {
      onDidChangeMcpServerDefinitions: didChange.event,

      provideMcpServerDefinitions(_token) {
        if (!auth.isAuthenticated || !isEnabled()) {
          return [];
        }
        return [
          new vscode.McpStdioServerDefinition(
            "Currents",
            "npx",
            ["-y", "@currents/mcp@latest"],
            {},
          ),
        ];
      },

      async resolveMcpServerDefinition(server, _token) {
        const key = await secrets.get(SECRET_KEY);
        if (!key) {
          return undefined;
        }
        server.env = { CURRENTS_API_KEY: key };
        return server;
      },
    };

  const registration = vscode.lm.registerMcpServerDefinitionProvider(
    "currentsProvider",
    provider,
  );

  log("MCP: registered VS Code MCP server definition provider");

  return vscode.Disposable.from(registration, authSub, configSub, didChange);
}

// ---------------------------------------------------------------------------
// Cursor: imperative register / unregister
// ---------------------------------------------------------------------------

function tryRegisterCursor(
  auth: AuthManager,
  secrets: vscode.SecretStorage,
): vscode.Disposable | undefined {
  const cursorMcp = (vscode as any).cursor?.mcp;
  if (!cursorMcp || typeof cursorMcp.registerServer !== "function") {
    log("MCP: vscode.cursor.mcp not available, skipping Cursor registration");
    return undefined;
  }

  let registered = false;

  async function register(): Promise<void> {
    if (!isEnabled() || !auth.isAuthenticated) {
      unregister();
      return;
    }
    const key = await secrets.get(SECRET_KEY);
    if (!key) {
      unregister();
      return;
    }

    // Unregister first to pick up new env values
    unregister();
    try {
      cursorMcp.registerServer({
        name: SERVER_NAME,
        server: {
          command: "npx",
          args: ["-y", "@currents/mcp@latest"],
          env: { CURRENTS_API_KEY: key },
        },
      });
      registered = true;
      log("MCP: registered Cursor MCP server");
    } catch (err) {
      log("MCP: failed to register Cursor MCP server:", String(err));
    }
  }

  function unregister(): void {
    if (!registered) {
      return;
    }
    try {
      cursorMcp.unregisterServer(SERVER_NAME);
    } catch {
      // server may already be unregistered
    }
    registered = false;
  }

  // Initial registration
  void register();

  const authSub = auth.onDidChangeAuth(() => void register());
  const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("currents.registerMcpServer")) {
      void register();
    }
  });

  return {
    dispose() {
      unregister();
      authSub.dispose();
      configSub.dispose();
    },
  };
}
