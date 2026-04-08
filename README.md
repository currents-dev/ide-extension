# Currents for VS Code

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/currents.currents?label=Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=currents.currents)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> Test reporting from [Currents.dev](https://currents.dev) — view runs, inspect errors, explore flaky tests, and fix them with AI, all without leaving your editor.

## Features

### Run Feed

Browse your latest CI test runs directly in the sidebar. Runs are filtered by your current git branch automatically and refresh every 30 seconds so you always see what's happening.

- Filter by **branch** or **author**
- Auto-refresh with a single toggle
- See status, commit message, duration, and spec group breakdown at a glance

### Run Details

Click any run to open a full detail panel with every spec and test result. Failed tests show error messages and stack traces inline.

- One-click **"Fix with Agent"** sends the failure context straight to your AI chat (Copilot, Cursor, etc.) to generate a fix
- **"Open in Dashboard"** jumps to the full Currents web UI for deeper analysis

### Test Explorer

Surface the **flakiest** and **slowest** tests across your project over configurable date ranges (14 / 30 / 60 / 90 days).

- Sort by flakiness rate or average duration
- Jump to the test file and line in one click
- Send flaky or slow tests to AI for automated analysis and fixes

### Analyze with Currents

An inline CodeLens / Quick Fix action appears above every test definition in your code. Trigger it to pull recent failure data from the Currents API and send a rich, context-aware prompt to your AI assistant.

### MCP Server Integration

The extension automatically registers a [Currents MCP server](https://www.npmjs.com/package/@currents/mcp) so AI agents in Cursor and VS Code can query runs, test results, and spec instances directly through tool calls.

## Getting Started

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=currents.currents) or search **"Currents"** in the Extensions panel.
2. Open the **Currents** panel in the Activity Bar.
3. Click **Set API Key** and paste your [Currents.dev](https://currents.dev) API key.
4. Select a project — your runs will appear immediately.

## Requirements

- A [Currents.dev](https://currents.dev) account with an API key
- VS Code 1.85+ or Cursor

## Extension Settings

| Setting                          | Default                       | Description                                                                            |
| -------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| `currents.filterByCurrentBranch` | `true`                        | Auto-filter runs by the current git branch                                             |
| `currents.notifyOnRunComplete`   | `false`                       | Show an OS notification when a run finishes                                            |
| `currents.analyzeTestDisplay`    | `always`                      | Show "Analyze with Currents" as CodeLens (`always`) or only via Quick Fix (`quickfix`) |
| `currents.apiBaseUrl`            | `https://api.currents.dev/v1` | API base URL (for self-hosted / enterprise)                                            |
| `currents.registerMcpServer`     | `true`                        | Auto-register the Currents MCP server for AI agents                                    |

## Development

```bash
git clone https://github.com/currents-dev/ide-extension.git
cd ide-extension
npm install
```

Press **F5** in VS Code to launch the Extension Development Host.

## License

[Apache 2.0](LICENSE)
