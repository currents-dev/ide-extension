# Changelog

All notable changes to the **Currents** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.0.1] — 2025-07-07

### Added

- **Run Feed** — browse recent CI test runs in the sidebar with auto-refresh (30 s interval).
- **Branch & Author filters** — filter runs by git branch (auto-detected) or commit author.
- **Run Detail panel** — click a run to see every spec and test result with inline error messages and stack traces.
- **Fix with Agent** — one-click action to send failure context to your AI assistant (Copilot, Cursor, etc.).
- **Open in Dashboard** — jump from any run to the full Currents web UI.
- **Test Explorer** — surface the flakiest and slowest tests over 14 / 30 / 60 / 90-day windows.
- **Analyze with Currents** — CodeLens and Quick Fix actions above test definitions that pull recent failure data and generate AI prompts.
- **MCP Server integration** — auto-registers a Currents MCP server so AI agents can query runs, test results, and spec instances via tool calls.
- **OS notifications** — optional desktop notifications when a tracked run completes.
- **Settings panel** — configure API key, project, notifications, branch filter, API base URL, and CodeLens display from the sidebar.
