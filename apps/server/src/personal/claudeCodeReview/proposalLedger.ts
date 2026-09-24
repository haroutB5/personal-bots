// @effect-diagnostics preferSchemaOverJson:off - a small JSON file shared with a node CLI and PowerShell; parsed defensively by hand.
/**
 * The proposal ledger of the nightly Claude Code update run: every proposal
 * the Updates bot ever made, with what happened to it. One JSON file
 * (`claude-code-updates/proposals.json` in the notes folder) shared by three
 * readers: the server (what carries over into the 04:00 run), the bot (through
 * `scripts/personal/updates/ledger.ts`, to record its decisions) and the ship
 * pipeline (to revert, ship and write the morning report).
 *
 * Numbering is global (P1, P2, ... never reused), so "approve P7" means one
 * proposal whichever report it came from.
 *
 * Pure: no filesystem, no clock. Callers pass `now` and persist the result.
 * Plain TypeScript with erasable syntax only, so node runs it directly.
 *
 * @module personal/claudeCodeReview/proposalLedger
 */

export type ProposalStatus =
  /** Made by a review, not yet decided by a nightly run. */
  | "open"
  /** The user said "approve P<n>": the next nightly run applies it. */
  | "approved"
  /** Rated risky, or it failed or was reverted: waits for "approve P<n>". */
  | "needs-approval"
  /** Committed by a run that has not shipped yet. */
  | "applied"
  /** Live in a release. */
  | "shipped"
  /** The user declined it. */
  | "rejected";

export type ProposalRating = "safe" | "risky";

export interface ProposalEvent {
  readonly at: string;
  readonly runId: string | null;
  readonly event: string;
  readonly detail?: string;
}

export interface ProposalEntry {
  /** `P<n>`. */
  readonly id: string;
  readonly title: string;
  /** The review that made it, e.g. "2.1.281". */
  readonly source: string;
  /** What, why, effort: enough for a run to act on without the review file. */
  readonly detail: string;
  readonly addedAt: string;
  readonly status: ProposalStatus;
  readonly rating: ProposalRating | null;
  /** Why it was rated as it was, or why it failed or was reverted. */
  readonly reason: string | null;
  readonly commits: ReadonlyArray<string>;
  /** Before/after notes for the morning report. */
  readonly notes: string | null;
  /** The app version it shipped in. */
  readonly version: string | null;
  /** The last run that decided, applied, reverted or shipped it. */
  readonly runId: string | null;
  readonly history: ReadonlyArray<ProposalEvent>;
}

export interface ProposalLedger {
  readonly version: 1;
  readonly nextNumber: number;
  readonly proposals: ReadonlyArray<ProposalEntry>;
}

export const EMPTY_LEDGER: ProposalLedger = { version: 1, nextNumber: 1, proposals: [] };

const STATUSES: ReadonlySet<string> = new Set<ProposalStatus>([
  "open",
  "approved",
  "needs-approval",
  "applied",
  "shipped",
  "rejected",
]);

export class LedgerError extends Error {}

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Reads a ledger file's text; missing or empty means an empty ledger. Throws on a corrupt file. */
export function parseLedger(raw: string | null): ProposalLedger {
  if (raw === null || raw.trim().length === 0) return EMPTY_LEDGER;
  let value: unknown;
  try {
    value = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (cause) {
    throw new LedgerError(`The proposal ledger is not valid JSON: ${String(cause)}`);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { proposals?: unknown }).proposals)
  ) {
    throw new LedgerError("The proposal ledger has no proposals array.");
  }
  const proposals: Array<ProposalEntry> = [];
  let highest = 0;
  for (const item of (value as { proposals: Array<Record<string, unknown>> }).proposals) {
    const id = text(item.id);
    const number = proposalNumber(id);
    if (number === null) throw new LedgerError(`Proposal id '${id}' is not P<n>.`);
    highest = Math.max(highest, number);
    const status = STATUSES.has(String(item.status)) ? (item.status as ProposalStatus) : "open";
    proposals.push({
      id: `P${number}`,
      title: text(item.title, `P${number}`),
      source: text(item.source),
      detail: text(item.detail),
      addedAt: text(item.addedAt),
      status,
      rating: item.rating === "safe" || item.rating === "risky" ? item.rating : null,
      reason: textOrNull(item.reason),
      commits: Array.isArray(item.commits) ? item.commits.filter((c) => typeof c === "string") : [],
      notes: textOrNull(item.notes),
      version: textOrNull(item.version),
      runId: textOrNull(item.runId),
      history: Array.isArray(item.history) ? (item.history as Array<ProposalEvent>) : [],
    });
  }
  const stored = Number((value as { nextNumber?: unknown }).nextNumber);
  return {
    version: 1,
    nextNumber: Math.max(highest + 1, Number.isInteger(stored) ? stored : 1),
    proposals,
  };
}

export function serializeLedger(ledger: ProposalLedger): string {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

/** 7 for "P7" or "p7", null for anything else. */
export function proposalNumber(id: string): number | null {
  const match = /^\s*[Pp](\d+)\s*$/.exec(id);
  return match === null ? null : Number(match[1]);
}

const find = (ledger: ProposalLedger, id: string): ProposalEntry => {
  const number = proposalNumber(id);
  const entry =
    number === null ? undefined : ledger.proposals.find((item) => item.id === `P${number}`);
  if (entry === undefined) throw new LedgerError(`No proposal ${id} in the ledger.`);
  return entry;
};

const replace = (
  ledger: ProposalLedger,
  id: string,
  change: (entry: ProposalEntry) => Partial<ProposalEntry>,
  event: Omit<ProposalEvent, "at" | "runId">,
  at: string,
  runId: string | null,
): ProposalLedger => {
  const target = find(ledger, id);
  return {
    ...ledger,
    proposals: ledger.proposals.map((entry) =>
      entry.id === target.id
        ? {
            ...entry,
            ...change(entry),
            history: [...entry.history, { at, runId, ...event }],
          }
        : entry,
    ),
  };
};

export interface NewProposal {
  readonly title: string;
  readonly source: string;
  readonly detail?: string;
}

/** Appends a proposal with the next free number; returns the ledger and its id. */
export function addProposal(
  ledger: ProposalLedger,
  proposal: NewProposal,
  at: string,
  runId: string | null,
): { readonly ledger: ProposalLedger; readonly id: string } {
  const title = proposal.title.trim();
  if (title.length === 0) throw new LedgerError("A proposal needs a title.");
  const id = `P${ledger.nextNumber}`;
  const entry: ProposalEntry = {
    id,
    title,
    source: proposal.source.trim(),
    detail: proposal.detail?.trim() ?? "",
    addedAt: at,
    status: "open",
    rating: null,
    reason: null,
    commits: [],
    notes: null,
    version: null,
    runId,
    history: [{ at, runId, event: "added" }],
  };
  return {
    ledger: {
      ...ledger,
      nextNumber: ledger.nextNumber + 1,
      proposals: [...ledger.proposals, entry],
    },
    id,
  };
}

/**
 * Records a run's rating. A risky proposal nobody approved waits for approval;
 * a safe one stays open until it is applied (or fails). An approved proposal
 * keeps its approval whatever the rating: the user already decided.
 */
export function decideProposal(
  ledger: ProposalLedger,
  id: string,
  rating: ProposalRating,
  reason: string,
  at: string,
  runId: string | null,
): ProposalLedger {
  const entry = find(ledger, id);
  if (entry.status !== "open" && entry.status !== "approved") {
    throw new LedgerError(
      `${entry.id} is ${entry.status}; only open or approved proposals are decided.`,
    );
  }
  const status: ProposalStatus =
    entry.status === "approved" ? "approved" : rating === "risky" ? "needs-approval" : "open";
  return replace(
    ledger,
    id,
    () => ({ rating, reason: reason.trim(), status, runId }),
    { event: `rated ${rating}`, detail: reason.trim() },
    at,
    runId,
  );
}

export function markApplied(
  ledger: ProposalLedger,
  id: string,
  commits: ReadonlyArray<string>,
  notes: string,
  at: string,
  runId: string | null,
): ProposalLedger {
  const entry = find(ledger, id);
  if (entry.status !== "open" && entry.status !== "approved") {
    throw new LedgerError(
      `${entry.id} is ${entry.status}; only open or approved proposals are applied.`,
    );
  }
  if (entry.status === "open" && entry.rating !== "safe") {
    throw new LedgerError(`${entry.id} was not rated safe; rate it first or wait for approval.`);
  }
  const clean = commits.map((commit) => commit.trim()).filter((commit) => commit.length > 0);
  if (clean.length === 0) throw new LedgerError("An applied proposal needs its commit(s).");
  return replace(
    ledger,
    id,
    () => ({ status: "applied", commits: clean, notes: notes.trim(), runId }),
    { event: "applied", detail: clean.join(", ") },
    at,
    runId,
  );
}

/** The bot could not implement it: it waits for the user. */
export function markFailed(
  ledger: ProposalLedger,
  id: string,
  reason: string,
  at: string,
  runId: string | null,
): ProposalLedger {
  return replace(
    ledger,
    id,
    () => ({ status: "needs-approval", reason: `could not be applied: ${reason.trim()}`, runId }),
    { event: "failed", detail: reason.trim() },
    at,
    runId,
  );
}

/** "approve P<n>": applied at the next nightly run. */
export function approveProposal(ledger: ProposalLedger, id: string, at: string): ProposalLedger {
  const entry = find(ledger, id);
  if (entry.status === "applied" || entry.status === "shipped") {
    throw new LedgerError(`${entry.id} is already ${entry.status}.`);
  }
  return replace(ledger, id, () => ({ status: "approved" }), { event: "approved" }, at, null);
}

export function rejectProposal(ledger: ProposalLedger, id: string, at: string): ProposalLedger {
  const entry = find(ledger, id);
  if (entry.status === "applied" || entry.status === "shipped") {
    throw new LedgerError(`${entry.id} is already ${entry.status}.`);
  }
  return replace(ledger, id, () => ({ status: "rejected" }), { event: "rejected" }, at, null);
}

/** Proposals a run applied (status applied, this run). */
export function appliedInRun(ledger: ProposalLedger, runId: string): ReadonlyArray<ProposalEntry> {
  return ledger.proposals.filter((entry) => entry.status === "applied" && entry.runId === runId);
}

/**
 * The run's commits were reverted (red gates, failed build, failed deploy):
 * everything it applied goes back to waiting for approval, with the reason.
 */
export function markRunReverted(
  ledger: ProposalLedger,
  runId: string,
  reason: string,
  at: string,
): ProposalLedger {
  let next = ledger;
  for (const entry of appliedInRun(ledger, runId)) {
    next = replace(
      next,
      entry.id,
      () => ({ status: "needs-approval", reason: `reverted: ${reason.trim()}` }),
      { event: "reverted", detail: reason.trim() },
      at,
      runId,
    );
  }
  return next;
}

export function markRunShipped(
  ledger: ProposalLedger,
  runId: string,
  version: string,
  at: string,
): ProposalLedger {
  let next = ledger;
  for (const entry of appliedInRun(ledger, runId)) {
    next = replace(
      next,
      entry.id,
      () => ({ status: "shipped", version }),
      { event: "shipped", detail: version },
      at,
      runId,
    );
  }
  return next;
}

/** What the next nightly run works on: undecided proposals and approved ones. */
export function actionableProposals(ledger: ProposalLedger): ReadonlyArray<ProposalEntry> {
  return ledger.proposals.filter((entry) => entry.status === "open" || entry.status === "approved");
}

export function awaitingApproval(ledger: ProposalLedger): ReadonlyArray<ProposalEntry> {
  return ledger.proposals.filter((entry) => entry.status === "needs-approval");
}

// ── Morning report ──────────────────────────────────────────────────────

/**
 * First words of a report that must reach the phone at once, quiet hours or
 * not: the pipeline could not leave Bots in a known-good state. Everything
 * else waits for the morning. The push service reads the same constant.
 */
export const URGENT_REPORT_PREFIX = "Needs attention";

export type RunResult =
  /** Nothing new and nothing carried over (normally skipped before any task). */
  | "nothing-to-do"
  /** Preflight refused (dirty tree, lock, another build); nothing changed. */
  | "preflight-blocked"
  /** The bot applied nothing (all risky, or nothing it could implement). */
  | "nothing-applied"
  | "gates-red"
  | "build-failed"
  | "push-rejected"
  | "shipped"
  /** The new release failed its checks; the previous one is live again. */
  | "rolled-back"
  /** The rollback failed too, or Bots is not answering. */
  | "down"
  /** The pipeline stopped on an unexpected error. */
  | "error"
  /** A rehearsal: everything up to push and restart, nothing shipped. */
  | "dry-run";

export interface RunOutcome {
  readonly runId: string;
  readonly mode: "live" | "dry-run";
  readonly result: RunResult;
  /** One-line human summary of the result. */
  readonly summary: string;
  readonly version: string | null;
  readonly release: string | null;
  readonly previousRelease: string | null;
  /** Pipeline facts for the report, one line each (gates, build, restart, checks). */
  readonly steps: ReadonlyArray<string>;
  /** True when Bots may not be serving a known-good release. */
  readonly urgent: boolean;
  /** A review of new releases that ran this time, if any. */
  readonly review: { readonly label: string; readonly reportFile: string } | null;
  readonly finishedAt: string;
}

const HEADLINE: Record<RunResult, string> = {
  "nothing-to-do": "nothing to do",
  "preflight-blocked": "did not start",
  "nothing-applied": "nothing applied",
  "gates-red": "changes reverted (gates red)",
  "build-failed": "changes reverted (build failed)",
  "push-rejected": "not shipped (push rejected)",
  shipped: "shipped",
  "rolled-back": "rolled back",
  down: "Bots may be down",
  error: "stopped on an error",
  "dry-run": "dry run",
};

const bullet = (entry: ProposalEntry, extra: string) =>
  `- ${entry.id} ${entry.title}${extra.length > 0 ? `. ${extra}` : ""}`;

/**
 * The morning report posted in the Updates chat: one headline, then applied
 * (commits and version), skipped with reasons, reverted, still waiting, and
 * the pipeline facts. Urgent reports start with {@link URGENT_REPORT_PREFIX}.
 */
export function renderMorningReport(ledger: ProposalLedger, outcome: RunOutcome): string {
  const date = outcome.finishedAt.slice(0, 10);
  const version = outcome.version === null ? "" : ` ${outcome.version}`;
  const headline = `${outcome.mode === "dry-run" ? "Dry run of the nightly update" : "Nightly update"} ${date}: ${HEADLINE[outcome.result]}${outcome.result === "shipped" || outcome.result === "dry-run" ? version : ""}`;
  const lines: Array<string> = [
    outcome.urgent ? `${URGENT_REPORT_PREFIX}: ${headline}` : headline,
    "",
    outcome.summary,
  ];
  if (outcome.mode === "dry-run") {
    lines.push(
      "",
      "Rehearsal only: nothing was pushed, restarted or kept. The changes were made in a throwaway worktree and a copy of the ledger.",
    );
  }
  const touched = ledger.proposals.filter((entry) => entry.runId === outcome.runId);
  const shipped = touched.filter(
    (entry) => entry.status === "shipped" || entry.status === "applied",
  );
  const reverted = touched.filter(
    (entry) => entry.status === "needs-approval" && entry.reason?.startsWith("reverted") === true,
  );
  const skipped = touched.filter(
    (entry) => entry.status === "needs-approval" && entry.reason?.startsWith("reverted") !== true,
  );
  if (shipped.length > 0) {
    lines.push("", outcome.result === "shipped" ? "Applied and live" : "Applied");
    for (const entry of shipped) {
      const commits = entry.commits.map((commit) => commit.slice(0, 10)).join(", ");
      lines.push(
        bullet(
          entry,
          [
            commits.length > 0
              ? `Commits ${commits}${entry.version !== null ? ` (in ${entry.version})` : ""}`
              : "",
            entry.notes ?? "",
          ]
            .filter((part) => part.length > 0)
            .join(". "),
        ),
      );
    }
  }
  if (reverted.length > 0) {
    lines.push("", "Reverted (reply 'approve P<n>' to retry tonight)");
    for (const entry of reverted) lines.push(bullet(entry, entry.reason ?? ""));
  }
  if (skipped.length > 0) {
    lines.push("", "Skipped (reply 'approve P<n>' to have it applied tonight)");
    for (const entry of skipped) lines.push(bullet(entry, entry.reason ?? ""));
  }
  const stillWaiting = awaitingApproval(ledger).filter((entry) => entry.runId !== outcome.runId);
  if (stillWaiting.length > 0) {
    lines.push(
      "",
      `Still waiting for your approval: ${stillWaiting.map((entry) => `${entry.id} (${entry.title})`).join("; ")}`,
    );
  }
  if (outcome.review !== null) {
    lines.push("", `New release review ${outcome.review.label}: ${outcome.review.reportFile}`);
  }
  if (outcome.steps.length > 0) {
    lines.push("", "Pipeline", ...outcome.steps.map((step) => `- ${step}`));
  }
  const releases = [
    outcome.release === null ? "" : `release ${outcome.release}`,
    outcome.previousRelease === null ? "" : `rollback target ${outcome.previousRelease}`,
  ].filter((part) => part.length > 0);
  if (releases.length > 0) lines.push(`- ${releases.join(", ")}`);
  lines.push("", `Run ${outcome.runId}.`);
  return lines.join("\n");
}

/** Whether a posted report is urgent: it starts with {@link URGENT_REPORT_PREFIX}. */
export function isUrgentReport(text: string): boolean {
  return text.trimStart().startsWith(URGENT_REPORT_PREFIX);
}
