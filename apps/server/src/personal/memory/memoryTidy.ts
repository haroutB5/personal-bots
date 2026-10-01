/**
 * The memory tidy-up's pure parts: how alike two entries are, the exact
 * duplicates it can fold without asking a model, the prompt it gives the
 * model, and the checks every proposed change must pass before it is made.
 *
 * The tidy-up only ever supersedes (an entry is kept, hidden from bots and
 * restorable) or merges (a new entry carries the combined text and the
 * originals are superseded by it). It never deletes, never crosses scopes,
 * and anything it is unsure of is left alone and listed.
 */
import * as Schema from "effect/Schema";

import { PERSONAL_MEMORY_MAX_LENGTH } from "@t3tools/contracts";

const SIMILARITY_STOP_WORDS = new Set(
  "about after again all also and any are because been before being both but can could did does doing done for from had has have her here him his how into its just more most not now off once only other our out over own same she should some such than that the their them then there these they this those through too under until very was were what when where which while who why will with would you your harout harout's user user's".split(
    " ",
  ),
);

/** The words that carry an entry's subject: 3+ letters, no stop words, no bare numbers. */
export function subjectWords(text: string): ReadonlySet<string> {
  const words = new Set<string>();
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.'-]*[\p{L}\p{N}]/gu) ?? []) {
    const word = raw.replace(/'s$/, "");
    if (word.length < 3 || /^[\d.-]+$/.test(word) || SIMILARITY_STOP_WORDS.has(word)) continue;
    words.add(word);
  }
  return words;
}

/** Dice similarity of two entries' subject words, 0 to 1. */
export function memorySimilarity(a: string, b: string): number {
  const left = subjectWords(a);
  const right = subjectWords(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/** At or above this, save_memory lists an entry back to the bot as a close match. */
export const SIMILAR_MEMORY_THRESHOLD = 0.3;

/** What the tidy-up knows about one entry. */
export interface TidyEntry {
  readonly memoryId: string;
  readonly scope: "shared" | "bot" | "project";
  readonly scopeId: string | null;
  readonly kind: "note" | "preference";
  readonly content: string;
  readonly source: string;
  readonly updatedAtMs: number;
  readonly version: number;
}

export type TidyDecision =
  | {
      readonly action: "merge";
      readonly memoryIds: ReadonlyArray<string>;
      readonly content: string;
      readonly reason: string;
    }
  | {
      readonly action: "supersede";
      readonly memoryIds: ReadonlyArray<string>;
      /** The entry that now carries the fact; null when it is simply out of date. */
      readonly by: string | null;
      readonly reason: string;
    }
  | {
      readonly action: "leave";
      readonly memoryIds: ReadonlyArray<string>;
      readonly reason: string;
    };

/** Entries in one scope: the tidy-up never merges or compares across these. */
export const scopeKey = (entry: Pick<TidyEntry, "scope" | "scopeId">) =>
  `${entry.scope}:${entry.scopeId ?? ""}`;

export function groupByScope(
  entries: ReadonlyArray<TidyEntry>,
): ReadonlyMap<string, ReadonlyArray<TidyEntry>> {
  const groups = new Map<string, Array<TidyEntry>>();
  for (const entry of entries) {
    const key = scopeKey(entry);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [entry]);
    else group.push(entry);
  }
  return groups;
}

const normalised = (content: string) => content.trim().replace(/\s+/g, " ").toLowerCase();

/** Newest first; the later-saved wins a tie. */
const newestFirst = (a: TidyEntry, b: TidyEntry) => b.updatedAtMs - a.updatedAtMs;

/**
 * Same text (ignoring case and spacing) saved more than once in one scope:
 * the newest copy stays, the others are superseded by it. No model needed.
 */
export function exactDuplicateDecisions(
  entries: ReadonlyArray<TidyEntry>,
): ReadonlyArray<TidyDecision> {
  const byText = new Map<string, Array<TidyEntry>>();
  for (const entry of entries) {
    const key = `${scopeKey(entry)}\n${normalised(entry.content)}`;
    const twins = byText.get(key);
    if (twins === undefined) byText.set(key, [entry]);
    else twins.push(entry);
  }
  const decisions: Array<TidyDecision> = [];
  for (const twins of byText.values()) {
    if (twins.length < 2) continue;
    const [keep, ...older] = twins.toSorted(newestFirst);
    decisions.push({
      action: "supersede",
      memoryIds: older.map((entry) => entry.memoryId),
      by: keep!.memoryId,
      reason: "Exact duplicate of a newer entry.",
    });
  }
  return decisions;
}

/** A user's own edit made in the last day is never undone by the tidy-up. */
export const RECENT_USER_EDIT_MS = 24 * 60 * 60 * 1000;

export const isRecentUserEdit = (entry: TidyEntry, nowMs: number) =>
  nowMs - entry.updatedAtMs < RECENT_USER_EDIT_MS && (entry.source === "user" || entry.version > 1);

/** At most this share of a scope's entries change in one run; the rest are left and listed. */
export const MAX_CHANGED_SHARE = 0.5;

const SECRET_SHAPED =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|token|api[_ -]?key|secret|bearer)\b\s*(?:is|=|:)\s*\S+/i;

/**
 * Checks proposed changes for one scope and splits them into the ones to make
 * and the ones to leave (with the reason). A change is left when it names an
 * entry outside the scope or already used by an earlier change, would undo a
 * user's edit from the last day, or would change more than half the scope.
 */
export function validateDecisions(
  entries: ReadonlyArray<TidyEntry>,
  proposed: ReadonlyArray<TidyDecision>,
  nowMs: number,
  looksLikeSecret: (text: string) => boolean = (text) => SECRET_SHAPED.test(text),
): { readonly apply: ReadonlyArray<TidyDecision>; readonly left: ReadonlyArray<TidyDecision> } {
  const byId = new Map(entries.map((entry) => [entry.memoryId, entry]));
  const used = new Set<string>();
  const apply: Array<TidyDecision> = [];
  const left: Array<TidyDecision> = [];
  const changeLimit = Math.max(1, Math.floor(entries.length * MAX_CHANGED_SHARE));
  let changed = 0;
  const leave = (decision: TidyDecision, why: string) =>
    left.push({
      action: "leave",
      memoryIds: decision.memoryIds.filter((id) => byId.has(id)),
      reason: decision.action === "leave" ? decision.reason : `${why} (${decision.reason})`,
    });

  for (const decision of proposed) {
    if (decision.action === "leave") {
      if (decision.memoryIds.some((id) => byId.has(id))) leave(decision, "");
      continue;
    }
    const ids = [...new Set(decision.memoryIds)];
    if (ids.length === 0 || ids.some((id) => !byId.has(id))) {
      leave(decision, "Names an entry that is not in this scope");
      continue;
    }
    if (decision.reason.trim().length === 0) {
      leave(decision, "No reason given");
      continue;
    }
    const by = decision.action === "supersede" ? decision.by : null;
    if (by !== null && (!byId.has(by) || ids.includes(by))) {
      leave(decision, "Replacement is not another entry in this scope");
      continue;
    }
    if (decision.action === "merge") {
      const content = decision.content.trim();
      if (ids.length < 2) {
        leave(decision, "A merge needs two or more entries");
        continue;
      }
      if (content.length === 0 || content.length > PERSONAL_MEMORY_MAX_LENGTH) {
        leave(decision, "Merged text is empty or too long");
        continue;
      }
      if (looksLikeSecret(content)) {
        leave(decision, "Merged text looks like it carries a secret");
        continue;
      }
    }
    const touched = by === null ? ids : [...ids, by];
    if (touched.some((id) => used.has(id))) {
      leave(decision, "Overlaps an earlier change in this run");
      continue;
    }
    if (ids.some((id) => isRecentUserEdit(byId.get(id)!, nowMs))) {
      leave(decision, "You edited one of these in the last day; your edit wins");
      continue;
    }
    if (changed + ids.length > changeLimit) {
      leave(decision, "Too many changes for one night; left for the next run");
      continue;
    }
    for (const id of touched) used.add(id);
    changed += ids.length;
    apply.push(decision.action === "merge" ? { ...decision, memoryIds: ids } : decision);
  }
  return { apply, left };
}

/** The most entries put in front of the model at once (newest kept). */
export const TIDY_MAX_ENTRIES_PER_CALL = 120;

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const CLOCK_FORMAT = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** YYYY-MM-DD in the server's own time zone (Harout's laptop: UK time). */
export const localDay = (ms: number): string => DAY_FORMAT.format(ms);

/** Minutes since local midnight. */
export function localMinuteOfDay(ms: number): number {
  const [hours = "0", minutes = "0"] = CLOCK_FORMAT.format(ms).split(":");
  return Number(hours) * 60 + Number(minutes);
}

/** Short refs (E1, E2, ...) stand for memory ids in the prompt. */
export function buildTidyPrompt(input: {
  readonly scopeLabel: string;
  readonly entries: ReadonlyArray<TidyEntry>;
  readonly todayIso: string;
  readonly appVersion: string | null;
}): { readonly prompt: string; readonly refs: ReadonlyMap<string, string> } {
  const refs = new Map<string, string>();
  const lines = input.entries.map((entry, index) => {
    const ref = `E${index + 1}`;
    refs.set(ref, entry.memoryId);
    return `${ref} | ${entry.kind} | ${localDay(entry.updatedAtMs)} | ${entry.content.replace(/\s+/g, " ")}`;
  });
  const prompt = [
    "You tidy the long-term memory of a personal assistant app: facts and standing rules the user asked their bots to remember. Bots receive every current entry, so stale or contradictory entries mislead them.",
    `Today is ${input.todayIso}.${input.appVersion === null ? "" : ` The assistant app itself (hbots, also called "personal-bots" or "the Bots app") is live at version ${input.appVersion}.`}`,
    `These are the ${input.scopeLabel} entries, one per line: ref | kind | date saved | text.`,
    "",
    ...lines,
    "",
    "Propose changes, as JSON decisions:",
    '- "supersede": older entries (memoryIds) are fully covered or contradicted by a newer entry on the same subject (by). Example: an older list of which model each bot runs, when a newer list covers the same bots; a rule that was later restated or changed. Also use it with by = null for an entry whose own words say it stopped applying and the other entries or the app version show that happened (e.g. "being built in 1.47.3" while the app is past 1.47.3; "until X" once X exists).',
    '- "merge": two or more entries (memoryIds) state the same fact or rule, each with details worth keeping. Write content: one self-contained entry that keeps every detail that is still true, drops what a newer entry changed, and starts with the newest date it carries.',
    '- "leave": entries you looked at and are unsure about (say why). Use it whenever you are not certain.',
    "Rules:",
    "- Only list entries you change or are unsure about. Entries you do not mention stay as they are.",
    "- Never put the same ref in two decisions. Refs must come from the list above.",
    "- Same subject only: do not merge entries just because they share words. Different people, apps, bots or decisions stay separate.",
    "- A newer entry wins over an older one only where they really conflict. If the older one has details the newer lacks, merge rather than supersede.",
    "- Chat wrap-ups and dated logs of past events are history: leave them alone unless two are the same text.",
    "- Never invent facts. Never copy a password, token or key into merged text.",
    "- Every decision needs a short reason a person can check.",
  ].join("\n");
  return { prompt, refs };
}

/** What the model returns: refs, not memory ids. */
export const TidyJudgeOutput = Schema.Struct({
  decisions: Schema.Array(
    Schema.Struct({
      action: Schema.Literals(["merge", "supersede", "leave"]),
      memoryIds: Schema.Array(Schema.String),
      by: Schema.optional(Schema.NullOr(Schema.String)),
      content: Schema.optional(Schema.NullOr(Schema.String)),
      reason: Schema.String,
    }),
  ),
});
export type TidyJudgeOutput = typeof TidyJudgeOutput.Type;

/**
 * Maps the model's refs back to memory ids. An unknown ref is kept as is, so
 * the validation step leaves that decision with a reason instead of dropping it.
 */
export function decisionsFromJudge(
  output: TidyJudgeOutput,
  refs: ReadonlyMap<string, string>,
): ReadonlyArray<TidyDecision> {
  const id = (ref: string) => refs.get(ref.trim().toUpperCase()) ?? `unknown:${ref}`;
  return output.decisions.map((decision): TidyDecision => {
    const memoryIds = decision.memoryIds.map(id);
    switch (decision.action) {
      case "merge":
        return {
          action: "merge",
          memoryIds,
          content: decision.content ?? "",
          reason: decision.reason,
        };
      case "supersede":
        return {
          action: "supersede",
          memoryIds,
          by: decision.by === undefined || decision.by === null ? null : id(decision.by),
          reason: decision.reason,
        };
      case "leave":
        return { action: "leave", memoryIds, reason: decision.reason };
    }
  });
}
