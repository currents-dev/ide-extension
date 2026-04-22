import type { RunFeedItem } from "../api/types.js";

/** Matches dashboard read-time title resolution (see docs/run-title.md). */
const SYNTHETIC_MERGE_RE = /^Merge (\S+) into (\S+)/;

export type RunTitleMeta = {
  title?: string | null;
  pr?: {
    id?: string | null;
    title?: string | null;
  } | null;
  commit?: {
    message?: string | null;
    ghaEventData?: {
      prTitle?: string | null;
    } | null;
  } | null;
  ciBuildId?: string | null;
  runId?: string | null;
};

export function firstLine(s: string | null | undefined): string {
  if (s == null || s === "") {
    return "";
  }
  const line = s.split("\n")[0];
  return line?.trim() ?? "";
}

export function isSyntheticMergeMessage(line: string): boolean {
  return SYNTHETIC_MERGE_RE.test(line.trim());
}

export function getPRTitleFromCanonicalId(
  prId: string | null | undefined,
): string | null {
  if (!prId) {
    return null;
  }
  const match = prId.match(/#(\d+)$/);
  return match ? `Pull Request #${match[1]}` : null;
}

export function getRunFallbackTitle(
  ciBuildId: string | null | undefined,
  runId: string | null | undefined,
): string {
  if (ciBuildId) {
    return `Run #${ciBuildId}`;
  }
  if (runId) {
    return `Run #${runId.slice(0, 6)}`;
  }
  return "Run";
}

export function resolveRunTitle(meta: RunTitleMeta): string {
  const prTitle =
    meta.pr?.title?.trim() ||
    meta.commit?.ghaEventData?.prTitle?.trim() ||
    "";
  if (prTitle) {
    return prTitle;
  }

  const prTitleFromId = getPRTitleFromCanonicalId(meta.pr?.id ?? undefined);
  if (prTitleFromId) {
    return prTitleFromId;
  }

  const storedLine = firstLine(meta.title ?? undefined);
  if (storedLine && !isSyntheticMergeMessage(storedLine)) {
    return storedLine;
  }

  const commitLine = firstLine(meta.commit?.message ?? undefined);
  if (commitLine && !isSyntheticMergeMessage(commitLine)) {
    return commitLine;
  }

  return getRunFallbackTitle(
    meta.ciBuildId ?? undefined,
    meta.runId ?? undefined,
  );
}

export function resolveRunTitleFromFeedItem(run: RunFeedItem): string {
  return resolveRunTitle({
    title: run.meta.title,
    pr: run.meta.pr,
    commit: run.meta.commit,
    ciBuildId: run.meta.ciBuildId,
    runId: run.runId,
  });
}
