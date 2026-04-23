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
 * Derives a canonical PR id (matching `meta.pr.id` format) from a GitHub
 * Actions PR html URL such as `https://github.com/owner/repo/pull/123`.
 * Returns `null` for non-GitHub or non-PR URLs.
 */
function prIdFromGithubHtmlUrl(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  const m = url.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i,
  );
  return m ? `github:github.com/${m[1]}#${m[2]}` : null;
}

/**
 * Stable key + header label for PR grouping. Prefers canonical `meta.pr.id`,
 * and falls back to `meta.commit.ghaEventData.htmlUrl` for GitHub Actions
 * runs (the list endpoint currently strips `meta.pr`).
 */
export function getPrGroupKeyAndLabel(run: RunFeedItem): {
  key: string;
  label: string;
} {
  const pr = run.meta.pr;
  const idFromPr =
    pr?.id != null && String(pr.id).trim() !== "" ? String(pr.id) : null;
  const id =
    idFromPr ?? prIdFromGithubHtmlUrl(run.meta.commit?.ghaEventData?.htmlUrl);
  if (id) {
    const fromTitle = pr?.title?.trim();
    const fromGha = run.meta.commit?.ghaEventData?.prTitle?.trim();
    const fromId = getPRTitleFromCanonicalId(id);
    const fromResolve = resolveRunTitleFromFeedItem(run);
    const label = fromTitle || fromGha || fromId || fromResolve;
    return { key: `pr:${id}`, label };
  }
  return { key: "__no_pr__", label: "No PR" };
}
