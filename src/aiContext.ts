import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { CurrentsApiClient } from "./api/client.js";
import type {
  AiContextError,
  AiContextFailureContext,
  AiContextPayload,
  AiContextStep,
} from "./api/types.js";

const CONTEXT_DIR = "currents-ai-context";

function formatErrorMarkdown(
  error: AiContextError,
  opts: { includeSnippet?: boolean; includeStack?: boolean } = {},
): string[] {
  const { includeSnippet = true, includeStack = true } = opts;
  const lines: string[] = [];
  const hasStack = includeStack && error.stack;

  if (!hasStack && error.message) {
    lines.push("**Error:**");
    lines.push("```");
    lines.push(error.message);
    lines.push("```");
  }

  if (error.location) {
    lines.push(
      `**Location:** \`${error.location.file}:${error.location.line}:${error.location.column}\``,
    );
  }
  lines.push("");

  if (includeSnippet && error.snippet) {
    lines.push("**Code:**");
    lines.push("```");
    lines.push(error.snippet);
    lines.push("```");
    lines.push("");
  }

  if (hasStack) {
    lines.push("**Stack:**");
    lines.push("```");
    lines.push(error.stack!);
    lines.push("```");
    lines.push("");
  }

  return lines;
}

function formatFailureContextMarkdown(fc: AiContextFailureContext): string[] {
  const lines: string[] = [];
  const failedStepNum = fc.failedStepIndex + 1;

  lines.push("## Failure Context");
  lines.push(
    `The test failed at step ${failedStepNum}. Here is the context around the failure:`,
  );

  if (fc.stepBefore) {
    const beforeStepNum = fc.failedStepIndex;
    const category = fc.stepBefore.category
      ? ` [${fc.stepBefore.category}]`
      : "";
    lines.push(
      `    ${beforeStepNum}. ${fc.stepBefore.title}${category} (${fc.stepBefore.duration}ms)`,
    );
  }

  const failedCategory = fc.failedStep.category
    ? ` [${fc.failedStep.category}]`
    : "";
  lines.push(
    `>>> ${failedStepNum}. ${fc.failedStep.title}${failedCategory} (${fc.failedStep.duration}ms) <<< FAILED`,
  );
  if (fc.failedStep.error?.message) {
    lines.push(`        Error: ${fc.failedStep.error.message.split("\n")[0]}`);
  }

  if (fc.stepAfter) {
    const afterStepNum = fc.failedStepIndex + 2;
    const category = fc.stepAfter.category ? ` [${fc.stepAfter.category}]` : "";
    lines.push(
      `    ${afterStepNum}. ${fc.stepAfter.title}${category} (${fc.stepAfter.duration}ms)`,
    );
  }
  lines.push("");

  return lines;
}

interface FlattenedStep {
  title: string;
  category?: string;
  duration: number;
  indent: number;
  hasError: boolean;
}

function flattenSteps(steps: AiContextStep[], indent = 0): FlattenedStep[] {
  const result: FlattenedStep[] = [];
  for (const step of steps) {
    result.push({
      title: step.title,
      category: step.category,
      duration: step.duration,
      indent,
      hasError: step.error != null,
    });
    if (step.steps && step.steps.length > 0) {
      result.push(...flattenSteps(step.steps, indent + 1));
    }
  }
  return result;
}

export function buildPromptMarkdown(payload: AiContextPayload): string {
  const lines: string[] = [];

  lines.push("FIX this failing test.");
  lines.push("");
  lines.push("# Test Failure Context");
  lines.push("");
  lines.push(`**Spec:** \`${payload.spec}\``);
  lines.push(`**Test:** ${payload.test.title.join(" > ")}`);
  lines.push(`**Status:** ${payload.test.status}`);
  const attemptLabel =
    payload.test.totalAttempts > 1
      ? `${payload.test.attempt} of ${payload.test.totalAttempts}`
      : `${payload.test.attempt}`;
  lines.push(`**Attempt:** ${attemptLabel}`);
  lines.push(`**Duration:** ${payload.test.duration}ms`);
  lines.push("");

  if (payload.error) {
    lines.push("## Error");
    lines.push("");
    lines.push(...formatErrorMarkdown(payload.error));
  }

  if (payload.failureContext) {
    lines.push(...formatFailureContextMarkdown(payload.failureContext));
  }

  if (payload.steps.length > 0) {
    lines.push("## All Steps");
    lines.push("");
    const flatSteps = flattenSteps(payload.steps);
    flatSteps.forEach((step, index) => {
      const nestIndent = "  ".repeat(step.indent);
      const category = step.category ? ` [${step.category}]` : "";
      const marker = step.hasError ? ">>> " : "    ";
      const suffix = step.hasError ? " <<< FAILED" : "";
      lines.push(
        `${nestIndent}${marker}${index + 1}. ${step.title}${category} (${step.duration}ms)${suffix}`,
      );
    });
    lines.push("");
  }

  if (payload.stdout.length > 0) {
    lines.push("## Stdout");
    lines.push("");
    lines.push("```");
    lines.push(payload.stdout.join("\n"));
    lines.push("```");
    lines.push("");
  }

  if (payload.stderr.length > 0) {
    lines.push("## Stderr");
    lines.push("");
    lines.push("```");
    lines.push(payload.stderr.join("\n"));
    lines.push("```");
    lines.push("");
  }

  const env = payload.environment;
  const hasEnvInfo = env.framework || env.platform || env.project;
  if (hasEnvInfo) {
    lines.push("## Environment");
    lines.push("");
    if (env.framework) {
      const version = env.framework.version || "unknown";
      lines.push(`- **Framework:** ${env.framework.type} ${version}`);
    }
    if (env.platform) {
      lines.push(
        `- **Browser:** ${env.platform.browserName} ${env.platform.browserVersion}`,
      );
      lines.push(`- **OS:** ${env.platform.osName} ${env.platform.osVersion}`);
    }
    if (env.project) {
      lines.push(`- **Project:** ${env.project}`);
    }
    lines.push("");
  }

  if (payload.otherAttempts.length > 0) {
    lines.push("## Other Attempts");
    lines.push("");
    for (const other of payload.otherAttempts) {
      if (other.error === null) {
        lines.push(
          `- **Attempt ${other.attempt}:** ${other.status} (no error)`,
        );
      } else {
        const msgPreview = other.error.message
          ? other.error.message.split("\n")[0].slice(0, 80)
          : "unknown";
        const location = other.error.location
          ? ` at \`${other.error.location.file}:${other.error.location.line}\``
          : "";
        const label = other.sameError ? "SAME ERROR" : "";
        lines.push(
          `- **Attempt ${other.attempt}:** ${label} \`${msgPreview}\`${location}`,
        );
      }
    }
    lines.push("");
  }

  lines.push("## Metadata (for MCP follow-up queries)");
  lines.push("");
  lines.push(`- **Project ID:** \`${payload.meta.projectId}\``);
  lines.push(`- **Run ID:** \`${payload.meta.runId}\``);
  lines.push(`- **Instance ID:** \`${payload.meta.instanceId}\``);
  lines.push(`- **Test ID:** \`${payload.meta.testId}\``);
  lines.push(`- **Attempt:** ${payload.meta.attempt}`);
  lines.push(`- **Signature:** \`${payload.meta.signature}\``);
  lines.push("");
  lines.push(
    "Use these identifiers with the Currents MCP tools (`currents-get-spec-instance`, `currents-get-test-results`, `currents-get-run-details`) for additional context if needed.",
  );

  return lines.join("\n");
}

export function buildBasicPrompt(msg: {
  spec: string;
  testTitle: string;
  displayError: string;
}): string {
  return `Please fix this failing test.\n\nFile: ${msg.spec}\nTest: ${msg.testTitle}\n\nError:\n${msg.displayError}`;
}

function ensureContextDir(): string {
  const dir = path.join(os.tmpdir(), CONTEXT_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export async function writeContextFiles(
  client: CurrentsApiClient,
  payload: AiContextPayload,
): Promise<vscode.Uri[]> {
  const uris: vscode.Uri[] = [];
  const dir = ensureContextDir();

  if (payload.errorContext?.url) {
    try {
      const content = await client.fetchUrl(payload.errorContext.url);
      const filePath = path.join(dir, "error-context.md");
      fs.writeFileSync(filePath, content, "utf8");
      uris.push(vscode.Uri.file(filePath));
    } catch {
      // Ignore fetch errors -- error context is optional
    }
  }

  if (payload.traceAnalyzerSummary) {
    const summary = payload.traceAnalyzerSummary;
    const hasContent =
      summary.consoleErrorsWarnings.length > 0 ||
      summary.failedNetworkRequests.length > 0;

    if (hasContent) {
      const lines: string[] = [];
      lines.push("# Trace Analyzer Summary");
      lines.push("");

      if (summary.consoleErrorsWarnings.length > 0) {
        lines.push("## Browser Console Errors/Warnings");
        lines.push("");
        for (const entry of summary.consoleErrorsWarnings) {
          const location = entry.location
            ? ` (${entry.location.url}:${entry.location.lineNumber}:${entry.location.columnNumber})`
            : "";
          lines.push(`- **[${entry.messageType}]** ${entry.text}${location}`);
        }
        lines.push("");
      }

      if (summary.failedNetworkRequests.length > 0) {
        lines.push("## Failed Network Requests");
        lines.push("");
        for (const req of summary.failedNetworkRequests) {
          const method = req.method || "GET";
          const status = req.status ? ` (${req.status})` : "";
          lines.push(`- ${method} ${req.url}${status}`);
        }
        lines.push("");
      }

      const filePath = path.join(dir, "trace-summary.md");
      fs.writeFileSync(filePath, lines.join("\n"), "utf8");
      uris.push(vscode.Uri.file(filePath));
    }
  }

  return uris;
}
