import type { RunFeedItem } from "../api/types.js";

/** Matches dashboard read-time title resolution (see docs/run-title.md). */
const SYNTHETIC_MERGE_RE = /^Merge (\S+) into (\S+)/;

export type RunTitleMeta = {
  title?: string | null;
  pr?: {
    id?: string | null;
    title?: string | null;
    link?: string | null;
  } | null;
  commit?: {
    message?: string | null;
    ghaEventData?: {
      prTitle?: string | null;
      htmlUrl?: string | null;
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

/**
 * Derives a stable PR identifier from the run metadata.
 * Tries (in order): canonical `meta.pr.id`, `meta.pr.link`,
 * then `meta.commit.ghaEventData.htmlUrl` — the list API may return
 * `meta.pr` without `id`, or omit `pr` entirely while keeping the
 * GitHub Actions event payload.
 */
function derivePrIdentifier(run: RunFeedItem): string | null {
  const pr = run.meta.pr;
  if (pr?.id && String(pr.id).trim() !== "") {
    return String(pr.id);
  }
  const linkCandidates = [pr?.link, run.meta.commit?.ghaEventData?.htmlUrl];
  for (const link of linkCandidates) {
    if (!link) {
      continue;
    }
    const m = link.match(
      /^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i,
    );
    if (m) {
      return `github:github.com/${m[1]}#${m[2]}`;
    }
  }
  return null;
}

/** Stable key + header label for PR grouping. */
export function getPrGroupKeyAndLabel(run: RunFeedItem): {
  key: string;
  label: string;
} {
  const id = derivePrIdentifier(run);
  if (id) {
    const fromTitle = run.meta.pr?.title?.trim();
    const fromGha = run.meta.commit?.ghaEventData?.prTitle?.trim();
    const fromId = getPRTitleFromCanonicalId(id);
    const fromResolve = resolveRunTitleFromFeedItem(run);
    const label = fromTitle || fromGha || fromId || fromResolve;
    return { key: `pr:${id}`, label };
  }
  return { key: "__no_pr__", label: "No PR" };
}
