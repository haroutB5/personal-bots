/**
 * Which notes and task summaries a turn is given. Pure: the service runs the
 * full-text search and hands the candidates here to be scored and capped.
 *
 * 1.60.40 changes over the keyword-only pick:
 * - the search words come from the message AND the chat title, the active
 *   apps and a few recent turns, so a short follow-up ("This works thx") is
 *   searched by what the chat is about, not by "works";
 * - words most entries hold carry no meaning and are left out;
 * - entries that record a status (a release armed, a QA result, a task
 *   summary) lose weight as they age, so last week's "armed" never beats a
 *   durable fact; they are never removed, only ranked lower;
 * - the picked entries are capped by count and by characters.
 *
 * Kill switch: `T3CODE_PERSONAL_MEMORY_RETRIEVAL=legacy` restores the
 * message-only search without ageing.
 */

export const RETRIEVAL_ENV = "T3CODE_PERSONAL_MEMORY_RETRIEVAL";

export const contextualRetrievalEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[RETRIEVAL_ENV]?.trim().toLowerCase() !== "legacy";

const STOP_WORDS = new Set(
  "a an and are as at be but by can could do does for from had has have how i if in into is it its me my no not of on or our please should so than that the their them then there these they this to up us was we were what when where which who why will with would you your".split(
    " ",
  ),
);

/** A message's searchable words, in order, once each. */
export function memoryQueryTerms(text: string): ReadonlyArray<string> {
  const terms: Array<string> = [];
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []) {
    if (STOP_WORDS.has(raw) || terms.includes(raw)) continue;
    terms.push(raw);
  }
  return terms;
}

/** An FTS5 OR query of quoted terms: quoting neutralises FTS syntax, a trailing * matches stems. */
export const termsToMatch = (terms: ReadonlyArray<string>): string | null =>
  terms.length === 0
    ? null
    : terms.map((term) => (term.length >= 4 ? `"${term}"*` : `"${term}"`)).join(" OR ");

/** A word held by more than this share of all entries says nothing about a topic. */
export const COMMON_TERM_SHARE = 0.2;
/** Below this many entries every word is informative (a tiny memory has no common words). */
const COMMON_TERM_MIN_DOCS = 50;
/** Most search words in one query. */
export const MAX_QUERY_TERMS = 16;
/** A follow-up searches by the chat's topic: fewer words, so weak matches stay out. */
export const MAX_FOLLOW_UP_TERMS = 12;
/** An entry must reach this share of the best score on a follow-up (0.2 otherwise). */
export const FOLLOW_UP_FLOOR = 0.3;
/** Context words added when the message itself is rich enough to search by. */
const CONTEXT_TERMS_WITH_RICH_MESSAGE = 3;
/** Fewer informative words than this and the message is a follow-up: the chat's topic leads. */
const RICH_MESSAGE_TERMS = 3;
/** Most words taken from each context source, so no long window floods the query. */
const TERMS_PER_CONTEXT_SOURCE = 6;

export interface QueryInput {
  readonly current: string;
  readonly title?: string | undefined;
  /** Names of the active apps (labels and aliases' words). */
  readonly appWords?: ReadonlyArray<string> | undefined;
  /** The messages just before this one, newest first, already bounded. */
  readonly recent?: ReadonlyArray<string> | undefined;
}

export interface QueryTerms {
  readonly terms: ReadonlyArray<string>;
  /** The message alone had too little to search by, so the chat's topic led. */
  readonly followUp: boolean;
  /** Where the terms came from, for the Context panel and the log. */
  readonly sources: {
    readonly message: ReadonlyArray<string>;
    readonly title: ReadonlyArray<string>;
    readonly apps: ReadonlyArray<string>;
    readonly recent: ReadonlyArray<string>;
  };
}

/** Every word the query could use, for one document-frequency lookup. */
export function candidateQueryTerms(input: QueryInput): ReadonlyArray<string> {
  const all = new Set<string>();
  for (const text of [
    input.current,
    input.title ?? "",
    ...(input.appWords ?? []),
    ...(input.recent ?? []),
  ]) {
    for (const term of memoryQueryTerms(text)) all.add(term);
    if (all.size >= 400) break;
  }
  return [...all];
}

/**
 * The words a turn searches by. `documentFrequency` is how many entries hold
 * each word (absent: the word is in no entry and cannot match); `totalDocs`
 * the number of entries.
 */
export function selectQueryTerms(
  input: QueryInput,
  documentFrequency: ReadonlyMap<string, number>,
  totalDocs: number,
): QueryTerms {
  const informative = (text: string) =>
    memoryQueryTerms(text).filter((term) => {
      const df = documentFrequency.get(term) ?? 0;
      if (df <= 0) return false;
      return totalDocs < COMMON_TERM_MIN_DOCS || df / totalDocs <= COMMON_TERM_SHARE;
    });
  const rarestFirst = (terms: ReadonlyArray<string>) =>
    terms.toSorted((a, b) => documentFrequency.get(a)! - documentFrequency.get(b)!);

  const message = rarestFirst(informative(input.current));
  const used = new Set(message);
  const fresh = (terms: ReadonlyArray<string>) => {
    const out: Array<string> = [];
    for (const term of rarestFirst(terms)) {
      if (used.has(term) || out.length >= TERMS_PER_CONTEXT_SOURCE) continue;
      used.add(term);
      out.push(term);
    }
    return out;
  };
  const apps = fresh((input.appWords ?? []).flatMap((word) => informative(word)));
  const title = fresh(informative(input.title ?? ""));
  const recent = fresh((input.recent ?? []).flatMap((text) => informative(text)));

  const followUp = message.length < RICH_MESSAGE_TERMS;
  const context = [...apps, ...title, ...recent];
  const terms = followUp
    ? [...message, ...context].slice(0, MAX_FOLLOW_UP_TERMS)
    : [
        ...message.slice(0, MAX_QUERY_TERMS - CONTEXT_TERMS_WITH_RICH_MESSAGE),
        ...context.slice(0, CONTEXT_TERMS_WITH_RICH_MESSAGE),
      ];
  return { terms, followUp, sources: { message, title, apps, recent } };
}

/** What ranking needs of an entry. */
export interface RankEntry {
  readonly memoryId: string;
  readonly kind: "note" | "preference" | "task_summary";
  readonly content: string;
  readonly source: string;
  readonly updatedAtMs: number;
  readonly temporalKind?: "stable" | "historical" | "changing" | null | undefined;
  readonly observedAt?: string | null | undefined;
  readonly verifiedAt?: string | null | undefined;
}

const STATUS_WORDS =
  /\b(?:armed|staged|waiter|rollback|rolled back|restarted|deployed|shipped|went live|live since|QA (?:SHIP|passed|failed|result)|smoke (?:exit|check|test)|built and gated|backup \d{6,8})\b/i;
const VERSION = /\b\d+\.\d+\.\d+\b/;

/**
 * Whether an entry records a state that goes stale: a task summary, or a note
 * about a release, a QA result or a pending step. A durable fact (a rule, a
 * preference, a fact about the owner, "Node 22.1.0 is required") is not: a
 * version alone never makes a note a status, and a status word alone does only
 * where the note says which version, or where an app, task or routine (not the
 * owner or a chat) wrote it.
 */
export function isStatusLike(entry: Pick<RankEntry, "kind" | "content" | "source" | "temporalKind">): boolean {
  if (entry.temporalKind != null) return entry.temporalKind !== "stable";
  if (entry.kind === "task_summary") return true;
  if (entry.kind !== "note") return false;
  if (/\b(?:currently|current (?:balance|status|price|version)|balance|available|availability|in stock|remaining|quota|expires|pending|waiting for|runs on|running on)\b/i.test(entry.content)) return true;
  if (!STATUS_WORDS.test(entry.content)) return false;
  return VERSION.test(entry.content) || /;from=(?:app|task|routine)/.test(entry.source);
}

/** Days after which a status entry's weight halves. */
export const STATUS_HALF_LIFE_DAYS = 14;
/** Even an old status entry keeps this share of its weight: ranked lower, never lost. */
export const STATUS_MIN_WEIGHT = 0.15;
const DAY_MS = 86_400_000;

const STATED_DATE = /(?:^|[\s("])(\d{4})-(\d{2})-(\d{2})(?![\d])/;

/**
 * When a status entry says it happened: the first ISO date in its opening
 * words ("2026-09-25: hbots 1.43.0 live"), else null. A later edit of the
 * entry (a tidy-up, a replaced reach) does not make the event newer.
 */
export function statedDateMs(content: string): number | null {
  const found = STATED_DATE.exec(content.slice(0, 60));
  if (found === null) return null;
  const ms = Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3]));
  return Number.isFinite(ms) ? ms : null;
}

/** 1 for a durable entry; for a status entry 0.5 per half-life since it happened (or was last written), floored. */
export function ageWeight(
  entry: Pick<RankEntry, "kind" | "content" | "source" | "updatedAtMs" | "temporalKind" | "observedAt" | "verifiedAt">,
  nowMs: number,
): number {
  if (!isStatusLike(entry)) return 1;
  const explicit = entry.verifiedAt ?? entry.observedAt;
  const stated = explicit && Number.isFinite(Date.parse(explicit)) ? Date.parse(explicit) : statedDateMs(entry.content);
  const happenedMs = stated === null ? entry.updatedAtMs : Math.min(entry.updatedAtMs, stated);
  const days = Math.max(0, (nowMs - happenedMs) / DAY_MS);
  return Math.max(STATUS_MIN_WEIGHT, 0.5 ** (days / STATUS_HALF_LIFE_DAYS));
}

/** A search hit: bm25 is negative, more negative is better. */
export interface Candidate<T extends RankEntry> {
  readonly entry: T;
  readonly bm25: number;
}

export interface RankOptions {
  readonly nowMs: number;
  /** Slugs of the apps this turn is about, and a test for whether text names an app. */
  readonly activeApps?: ReadonlySet<string> | undefined;
  readonly mentionsApp?: ((text: string, slug: string) => boolean) | undefined;
  /** Every app slug the text could be about (to spot another app's entries). */
  readonly knownApps?: ReadonlyArray<string> | undefined;
  /** Entries the owner marked outdated or not relevant: ranked lower. */
  readonly demoted?: ReadonlyMap<string, DemotionSignal> | undefined;
  /** Ageing on (default) or off (legacy). */
  readonly ageing?: boolean | undefined;
  /** An entry must reach this share of the best adjusted score. */
  readonly floor: number;
  readonly limit: number;
}

export interface Ranked<T extends RankEntry> {
  readonly entry: T;
  /** Relevance after weights: bigger is better. */
  readonly score: number;
  readonly bm25: number;
  readonly weight: number;
  readonly why: ReadonlyArray<string>;
}

/** Weight of an entry about an app the turn is not about, while the turn is about another. */
export const OTHER_APP_WEIGHT = 0.6;
/** Weight of an entry that names an active app. */
export const ACTIVE_APP_WEIGHT = 1.25;
/** The reason shown for an entry picked on its keywords alone. */
export const MATCHED_WORDS = "matched words";
/** What the owner said about an entry in the "Context used" view. */
export type DemotionSignal = "outdated" | "not_relevant";
/** Weight of an entry marked outdated (no longer true) or not relevant (off topic). */
export const DEMOTION_WEIGHT: Record<DemotionSignal, number> = {
  outdated: 0.1,
  not_relevant: 0.35,
};

/**
 * Scores candidates: bm25 relevance times an age weight for status entries, a
 * boost for an active app's entries, a cut for another app's, and a cut for
 * demoted ones. Keeps those within `floor` of the best, best first, up to
 * `limit`. `leftOut` names the candidates that matched but did not make it.
 */
export function rankCandidates<T extends RankEntry>(
  candidates: ReadonlyArray<Candidate<T>>,
  options: RankOptions,
): { readonly picked: ReadonlyArray<Ranked<T>>; readonly leftOut: ReadonlyArray<Ranked<T>> } {
  const active = options.activeApps ?? new Set<string>();
  const mentions = options.mentionsApp;
  const scored = candidates.map(({ entry, bm25 }): Ranked<T> => {
    const why: Array<string> = [];
    let weight = 1;
    if (options.ageing !== false) {
      const age = ageWeight(entry, options.nowMs);
      if (age < 1) {
        weight *= age;
        why.push(`older status entry (x${age.toFixed(2)})`);
      }
    }
    if (mentions !== undefined && (active.size > 0 || (options.knownApps?.length ?? 0) > 0)) {
      const names = (slug: string) => mentions(entry.content, slug);
      if ([...active].some(names)) {
        weight *= ACTIVE_APP_WEIGHT;
        why.push("names an app this chat is about");
      } else if (active.size > 0 && (options.knownApps ?? []).some(names)) {
        weight *= OTHER_APP_WEIGHT;
        why.push("about another app");
      }
    }
    const mark = options.demoted?.get(entry.memoryId);
    if (mark !== undefined) {
      weight *= mark === "outdated" ? 0 : DEMOTION_WEIGHT[mark];
      why.push(mark === "outdated" ? "you marked it outdated" : "you marked it not relevant");
    }
    return { entry, bm25, weight, score: -bm25 * weight, why };
  });
  const ordered = scored.toSorted(
    (a, b) => b.score - a.score || b.entry.updatedAtMs - a.entry.updatedAtMs,
  );
  const best = ordered[0]?.score ?? 0;
  const strong = ordered.filter((row) => row.score > 0 && row.score >= best * options.floor);
  const chosen = strong.slice(0, options.limit);
  const pickedSet = new Set(chosen);
  return {
    // An entry nothing weighed on was picked on its words alone: say so.
    picked: chosen.map((row) => (row.why.length > 0 ? row : { ...row, why: [MATCHED_WORDS] })),
    leftOut: ordered.filter((row) => !pickedSet.has(row)),
  };
}

/** Most characters of notes and task summaries in one turn, after each is clipped. */
export const RELEVANT_MAX_CHARS = 4_000;

/**
 * The picked entries cut to the character cap, in rank order: once one does
 * not fit, it and every lower-ranked one are left out.
 */
export function capByChars<T extends { readonly entry: { readonly content: string } }>(
  ranked: ReadonlyArray<T>,
  lineChars: (item: T) => number,
  maxChars: number,
): { readonly kept: ReadonlyArray<T>; readonly leftOut: ReadonlyArray<T> } {
  const kept: Array<T> = [];
  const leftOut: Array<T> = [];
  let chars = 0;
  let full = false;
  for (const item of ranked) {
    const size = lineChars(item);
    if (full || chars + size > maxChars) {
      full = true;
      leftOut.push(item);
      continue;
    }
    chars += size;
    kept.push(item);
  }
  return { kept, leftOut };
}

/** Task summaries of one task title in a turn: an hourly routine writes dozens that read alike. */
export const MAX_SUMMARIES_PER_TITLE = 2;

const SUMMARY_TITLE = /^Task "([^"]*)"/;

/**
 * Keeps the newest few task summaries of each task title (the first listed
 * when no recency is given) and passes every other entry through, so a routine that runs hourly cannot fill
 * the turn with near-identical summaries.
 */
export function limitSummariesPerTitle<
  T extends { readonly content: string; readonly kind: string },
>(
  candidates: ReadonlyArray<T>,
  perTitle: number = MAX_SUMMARIES_PER_TITLE,
  /** When an entry was written: of one title, the newest are kept, not the best keyword matches. */
  recency?: (entry: T) => number,
): ReadonlyArray<T> {
  const titleOf = (entry: T) =>
    entry.kind === "task_summary" ? SUMMARY_TITLE.exec(entry.content)?.[1] : undefined;
  // Which of each title to keep: the newest (when told how new they are), else the first listed.
  const keep = new Set<T>();
  const groups = new Map<string, Array<T>>();
  for (const entry of candidates) {
    const title = titleOf(entry);
    if (title === undefined) {
      keep.add(entry);
      continue;
    }
    groups.set(title, [...(groups.get(title) ?? []), entry]);
  }
  for (const group of groups.values()) {
    const ordered =
      recency === undefined ? group : group.toSorted((a, b) => recency(b) - recency(a));
    for (const entry of ordered.slice(0, perTitle)) keep.add(entry);
  }
  // Kept entries stay in the order they came in (their keyword rank).
  return candidates.filter((entry) => keep.has(entry));
}
