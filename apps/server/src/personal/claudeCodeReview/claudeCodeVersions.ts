/**
 * Pure version and changelog logic for the Claude Code update review.
 *
 * Claude Code and the Claude Agent SDK release in lockstep (SDK 0.3.N carries
 * "Updated to parity with Claude Code v2.1.N"), and both changelogs are
 * Markdown with one `## <version>` section per release, newest first. This
 * module decides whether a review is due, what version range it covers, and
 * builds the changelog excerpt the reviewing bot reads.
 *
 * @module personal/claudeCodeReview/claudeCodeVersions
 */

const VERSION_PATTERN = /^\d+(?:\.\d+)*$/;

/** A plain dotted numeric version (`2.1.281`), or null for anything else. */
export function normalizeVersion(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  // `claude --version` prints "2.1.281 (Claude Code)"; a package spec reads "^0.3.260".
  const match = /\d+(?:\.\d+)+/.exec(raw.trim().replace(/^[\^~=v]+/, ""));
  if (match === null) return null;
  return VERSION_PATTERN.test(match[0]) ? match[0] : null;
}

/** Numeric, part by part; a missing part counts as 0 (`2.1` == `2.1.0`). */
export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/** The newest of the given versions, ignoring nulls. */
export function maxVersion(...versions: ReadonlyArray<string | null>): string | null {
  let best: string | null = null;
  for (const version of versions) {
    if (version === null) continue;
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

export interface ChangelogSection {
  readonly version: string;
  /** The section's lines after its heading, trimmed of blank edges. */
  readonly body: string;
}

/** Splits a changelog into `## <version>` sections, in file order (newest first). */
export function parseChangelog(markdown: string): ReadonlyArray<ChangelogSection> {
  const sections: Array<ChangelogSection> = [];
  let current: { version: string; lines: Array<string> } | null = null;
  const flush = () => {
    if (current !== null) {
      sections.push({ version: current.version, body: current.lines.join("\n").trim() });
    }
  };
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+\[?v?(\d+(?:\.\d+)+)\]?(?:\s|$)/.exec(line);
    if (heading !== null) {
      flush();
      current = { version: heading[1]!, lines: [] };
      continue;
    }
    // A level-1 heading or anything above the first section is preamble.
    if (current !== null && !/^#\s/.test(line)) current.lines.push(line);
  }
  flush();
  return sections;
}

/** Sections with `from < version <= to`, newest first. A null `from` means "everything up to `to`". */
export function sectionsInRange(
  sections: ReadonlyArray<ChangelogSection>,
  from: string | null,
  to: string,
): ReadonlyArray<ChangelogSection> {
  return sections
    .filter(
      (section) =>
        compareVersions(section.version, to) <= 0 &&
        (from === null || compareVersions(section.version, from) > 0),
    )
    .toSorted((left, right) => compareVersions(right.version, left.version));
}

/** The Claude Code version an SDK release says it matches ("parity with Claude Code v2.1.260"). */
export function sdkParityVersion(
  sdkSections: ReadonlyArray<ChangelogSection>,
  sdkVersion: string,
): string | null {
  const section = sdkSections.find((entry) => compareVersions(entry.version, sdkVersion) === 0);
  if (section === undefined) return null;
  const match = /parity with Claude Code v?(\d+(?:\.\d+)+)/i.exec(section.body);
  return match === null ? null : match[1]!;
}

// ── Review state ────────────────────────────────────────────────────────

/** Persisted in `personal_meta`; see {@link CLAUDE_CODE_REVIEW_STATE_KEY}. */
export interface ClaudeCodeReviewState {
  /** The newest Claude Code version a review covered (or the recorded baseline). */
  readonly reviewedClaudeCode: string | null;
  /** The newest Agent SDK version a review covered (or the recorded baseline). */
  readonly reviewedSdk: string | null;
  /** When the registry was last read successfully (ISO). Drives the daily cadence. */
  readonly lastCheckedAt: string | null;
  readonly lastReview: {
    readonly claudeCode: string;
    readonly sdk: string | null;
    readonly taskId: string;
    readonly firedAt: string;
  } | null;
}

export const EMPTY_REVIEW_STATE: ClaudeCodeReviewState = {
  reviewedClaudeCode: null,
  reviewedSdk: null,
  lastCheckedAt: null,
  lastReview: null,
};

export const CLAUDE_CODE_REVIEW_STATE_KEY = "claude-code-review:state";

export function parseReviewState(raw: string | null): ClaudeCodeReviewState {
  if (raw === null) return EMPTY_REVIEW_STATE;
  try {
    const value = JSON.parse(raw) as Partial<ClaudeCodeReviewState> | null;
    if (value === null || typeof value !== "object") return EMPTY_REVIEW_STATE;
    return {
      reviewedClaudeCode: normalizeVersion(value.reviewedClaudeCode ?? null),
      reviewedSdk: normalizeVersion(value.reviewedSdk ?? null),
      lastCheckedAt: typeof value.lastCheckedAt === "string" ? value.lastCheckedAt : null,
      lastReview:
        value.lastReview && typeof value.lastReview === "object" ? value.lastReview : null,
    };
  } catch {
    return EMPTY_REVIEW_STATE;
  }
}

/** What the daily check saw. Any field may be null when its source was unreachable. */
export interface ObservedVersions {
  /** `@anthropic-ai/claude-code` latest on npm. */
  readonly latestClaudeCode: string | null;
  /** The native claude.exe the bots run on, from the provider snapshot. */
  readonly installedClaudeCode: string | null;
  /** `@anthropic-ai/claude-agent-sdk` latest on npm. */
  readonly latestSdk: string | null;
  /** The SDK version hbots is built with. */
  readonly pinnedSdk: string | null;
  /** Claude Code version the pinned SDK matches; only needed before the first review. */
  readonly pinnedSdkParityClaudeCode: string | null;
}

export interface VersionRange {
  /** Exclusive lower bound: the last version already reviewed. */
  readonly from: string | null;
  /** Inclusive upper bound. */
  readonly to: string;
}

export type ReviewDecision =
  /** Nothing newer than what was reviewed. */
  | { readonly _tag: "UpToDate" }
  /** No reviewed state and no way to place the pinned SDK: record today's versions, review nothing. */
  | { readonly _tag: "Baseline"; readonly claudeCode: string; readonly sdk: string | null }
  | {
      readonly _tag: "Review";
      readonly claudeCode: VersionRange | null;
      readonly sdk: VersionRange | null;
    };

/**
 * Once per version: a review is due when Claude Code (the newest of npm latest
 * and the installed binary) or the SDK moved past what was last reviewed.
 *
 * The first review has no reviewed state and starts from the pinned SDK: the
 * Claude Code version that SDK matches, and the SDK version itself. So the
 * first report covers everything hbots has not adopted yet.
 */
export function decideReview(
  state: ClaudeCodeReviewState,
  observed: ObservedVersions,
): ReviewDecision {
  const targetClaudeCode = maxVersion(observed.latestClaudeCode, observed.installedClaudeCode);
  const targetSdk = maxVersion(observed.latestSdk, observed.pinnedSdk);
  if (targetClaudeCode === null) return { _tag: "UpToDate" };
  const fromClaudeCode = state.reviewedClaudeCode ?? observed.pinnedSdkParityClaudeCode;
  if (fromClaudeCode === null) {
    return { _tag: "Baseline", claudeCode: targetClaudeCode, sdk: targetSdk };
  }
  const fromSdk = state.reviewedSdk ?? observed.pinnedSdk;
  const claudeCodeMoved = compareVersions(targetClaudeCode, fromClaudeCode) > 0;
  const sdkMoved =
    targetSdk !== null && fromSdk !== null && compareVersions(targetSdk, fromSdk) > 0;
  if (!claudeCodeMoved && !sdkMoved) return { _tag: "UpToDate" };
  return {
    _tag: "Review",
    claudeCode: claudeCodeMoved ? { from: fromClaudeCode, to: targetClaudeCode } : null,
    sdk: sdkMoved && targetSdk !== null ? { from: fromSdk, to: targetSdk } : null,
  };
}

/**
 * What counts as reviewed once a review has started: the newest version whose
 * notes were in the excerpt, never going backwards. A release that is on npm
 * before its changelog section is published stays unreviewed, so the next
 * check picks it up with its notes instead of it being skipped for good.
 */
export function reviewedThrough(
  previous: string | null,
  range: VersionRange | null,
  versionsWithNotes: ReadonlyArray<string>,
): string | null {
  return maxVersion(previous, range?.from ?? null, versionsWithNotes[0] ?? null);
}

// ── Excerpt ─────────────────────────────────────────────────────────────

/** Past this many characters of Claude Code changelog, older versions are condensed. */
export const EXCERPT_FULL_TEXT_BUDGET = 240_000;
const CONDENSED_BULLETS = 3;
const CONDENSED_BULLET_CHARS = 200;

function condense(body: string): string {
  const bullets = body
    .split(/\r?\n/)
    .filter((line) => /^\s*[-*]\s/.test(line))
    .map((line) =>
      line.length > CONDENSED_BULLET_CHARS
        ? `${line.slice(0, CONDENSED_BULLET_CHARS - 1).trimEnd()}…`
        : line,
    );
  const shown = bullets.slice(0, CONDENSED_BULLETS);
  const rest = bullets.length - shown.length;
  return [...shown, ...(rest > 0 ? [`- (+${rest} more entries, see the full changelog)`] : [])]
    .join("\n")
    .trim();
}

export interface ExcerptInput {
  readonly claudeCode: VersionRange | null;
  readonly sdk: VersionRange | null;
  readonly claudeCodeSections: ReadonlyArray<ChangelogSection>;
  readonly sdkSections: ReadonlyArray<ChangelogSection>;
  readonly observed: ObservedVersions;
  readonly generatedAt: string;
  readonly fullTextBudget?: number;
}

export interface Excerpt {
  readonly markdown: string;
  readonly claudeCodeVersions: ReadonlyArray<string>;
  readonly sdkVersions: ReadonlyArray<string>;
  /** Versions that got only their first few entries because the range was large. */
  readonly condensedVersions: ReadonlyArray<string>;
}

/**
 * The changelog entries the review covers: every Claude Code section in range
 * in full, newest first, until the budget runs out; older sections are
 * condensed to their first entries. The SDK changelog is small and always
 * included in full.
 */
export function buildExcerpt(input: ExcerptInput): Excerpt {
  const budget = input.fullTextBudget ?? EXCERPT_FULL_TEXT_BUDGET;
  const claudeCode =
    input.claudeCode === null
      ? []
      : sectionsInRange(input.claudeCodeSections, input.claudeCode.from, input.claudeCode.to);
  const sdk =
    input.sdk === null ? [] : sectionsInRange(input.sdkSections, input.sdk.from, input.sdk.to);
  const condensedVersions: Array<string> = [];
  const claudeCodeBlocks: Array<string> = [];
  let used = 0;
  let overBudget = false;
  for (const section of claudeCode) {
    const full = `### ${section.version}\n\n${section.body}`;
    // Once one release does not fit, every older one is condensed too, so the
    // in-depth part is always one contiguous run of the newest releases.
    overBudget ||= used + full.length > budget;
    if (!overBudget) {
      claudeCodeBlocks.push(full);
      used += full.length;
    } else {
      condensedVersions.push(section.version);
      claudeCodeBlocks.push(`### ${section.version} (condensed)\n\n${condense(section.body)}`);
    }
  }
  const range = (value: VersionRange | null) =>
    value === null ? "no change" : `after ${value.from ?? "(start)"} up to ${value.to}`;
  const header = [
    "# Claude Code / Agent SDK changelog excerpt",
    "",
    `Generated ${input.generatedAt} by the hbots update check.`,
    "",
    `- Claude Code: ${range(input.claudeCode)} (${claudeCode.length} release(s) with notes)`,
    `- Agent SDK: ${range(input.sdk)} (${sdk.length} release(s) with notes)`,
    `- Installed claude.exe: ${input.observed.installedClaudeCode ?? "unknown"}; npm latest: ${input.observed.latestClaudeCode ?? "unknown"}`,
    `- SDK pinned by hbots: ${input.observed.pinnedSdk ?? "unknown"}; npm latest: ${input.observed.latestSdk ?? "unknown"}`,
    ...(condensedVersions.length > 0
      ? [
          `- The range is large: ${condensedVersions.length} older release(s) are condensed to their first entries (${condensedVersions.at(-1)} to ${condensedVersions[0]}). Cover them in summary only.`,
        ]
      : []),
  ];
  const markdown = [
    ...header,
    "",
    "## Claude Code changelog",
    "",
    claudeCodeBlocks.length > 0 ? claudeCodeBlocks.join("\n\n") : "(no Claude Code changes)",
    "",
    "## Agent SDK changelog",
    "",
    sdk.length > 0
      ? sdk.map((section) => `### ${section.version}\n\n${section.body}`).join("\n\n")
      : "(no Agent SDK changes)",
    "",
  ].join("\n");
  return {
    markdown,
    claudeCodeVersions: claudeCode.map((section) => section.version),
    sdkVersions: sdk.map((section) => section.version),
    condensedVersions,
  };
}
