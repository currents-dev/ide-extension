import { randomUUID } from "node:crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { CurrentsApiClient } from "./api/client.js";

const CONTEXT_DIR = "currents-ai-context";

/**
 * Server returns fully-rendered markdown from GET /v1/context?format=md.
 * Prepend a short instruction line (matches dashboard `buildEnrichedPrompt`).
 */
export function buildEnrichedPrompt(spec: string, markdown: string): string {
  return `Fix this Playwright test failure in ${spec}:\n\n${markdown}`;
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

/** Download Playwright error-context snapshot (accessibility tree) for chat attachment. */
export async function writeContextFiles(
  client: CurrentsApiClient,
  errorContextUrl: string | null,
): Promise<vscode.Uri[]> {
  if (!errorContextUrl) {
    return [];
  }
  try {
    const content = await client.fetchUrl(errorContextUrl);
    const dir = path.join(ensureContextDir(), randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "error-context.md");
    fs.writeFileSync(filePath, content, "utf8");
    return [vscode.Uri.file(filePath)];
  } catch {
    return [];
  }
}

export async function writeRunContextFiles(
  client: CurrentsApiClient,
  runId: string,
  entries: Array<{ testId: string; url: string }>,
): Promise<vscode.Uri[]> {
  if (entries.length === 0) return [];
  const dir = path.join(ensureContextDir(), `run-${runId}`);
  fs.mkdirSync(dir, { recursive: true });

  const uris: vscode.Uri[] = [];
  await Promise.all(
    entries.map(async ({ testId, url }) => {
      try {
        const content = await client.fetchUrl(url);
        const filePath = path.join(dir, `error-context-${testId}.md`);
        fs.writeFileSync(filePath, content, "utf8");
        uris.push(vscode.Uri.file(filePath));
      } catch {
        // Skip individual failures; best-effort attachment.
      }
    }),
  );
  return uris;
}
