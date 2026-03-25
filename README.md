# Currents for VS Code

View test runs, inspect errors, and fix failing tests with AI — all without leaving your IDE.

## Features

- **Sidebar with test runs**: See your latest Currents.dev test runs filtered by branch and author
- **Error drill-down**: Click a run to see all failed tests grouped by spec file, with error messages and stack traces
- **Fix with Agent**: One-click button to send failing test context to VS Code AI chat for automated fixes
- **Branch auto-detection**: Automatically filters runs to your current git branch
- **Open in Dashboard**: Jump to the full Currents dashboard for any run

## Getting Started

1. Open the Currents panel in the Activity Bar (sidebar)
2. Click "Set API Key" and enter your Currents.dev API key
3. Select a project (if your org has multiple)
4. Browse runs, click into errors, and fix them with AI

## Development

```bash
npm install
# Press F5 in VS Code to launch the Extension Development Host
```

## Commands

All commands are available via the Command Palette (`Ctrl+Shift+P`) under the "Currents" category:

- **Set API Key** — configure your Currents.dev API key
- **Remove API Key** — disconnect your account
- **Select Project** — switch between projects
- **Refresh Runs** — reload the runs list
- **Filter by Branch** — filter runs by git branch
- **Filter by Author** — filter runs by commit author
- **Clear Filters** — remove all active filters
- **Fix with Agent** — send a failing test to AI chat
- **Open in Dashboard** — view run details on currents.dev
