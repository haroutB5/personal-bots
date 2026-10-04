/**
 * App-scoped rules: which apps a standing rule is about, which apps a turn is
 * about, and how a turn's rules are picked and capped. Pure: no database, no
 * clock, so every rule below is unit-tested on its own.
 *
 * A rule with `apps` null is global and always included. A rule with apps is
 * included in full only when one of its apps is active in the turn; otherwise
 * it is counted in a one-line index ("Matchday: 5 rules") so a bot can still
 * fetch it with search_memory. Global rules are never dropped by any cap.
 *
 * Kill switch: `T3CODE_PERSONAL_MEMORY_APP_SCOPING=off` treats every rule as
 * global again (the 1.60.39 behaviour).
 */

import { PERSONAL_MEMORY_APPS, type PersonalMemoryApp } from "@t3tools/contracts";

export const APP_SCOPING_ENV = "T3CODE_PERSONAL_MEMORY_APP_SCOPING";

/** Whether app scoping is on (the default). Read per call so a test can flip it. */
export const appScopingEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[APP_SCOPING_ENV]?.trim().toLowerCase() !== "off";

export type MemoryApp = PersonalMemoryApp;

/** The apps in C:/Claude/AI/dev-team/apps/*.md and what each is called (shared with the web client). */
export const MEMORY_APPS: ReadonlyArray<MemoryApp> = PERSONAL_MEMORY_APPS;

const APP_BY_SLUG = new Map(MEMORY_APPS.map((app) => [app.slug, app] as const));

/** A slug as stored: lower case letters, digits and hyphens. Null when nothing is left. */
export function normaliseAppSlug(value: string): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length === 0 || slug.length > 40 ? null : slug;
}

/** The apps a rule is limited to, normalised and once each; null (global) when none. */
export function normaliseApps(
  apps: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<string> | null {
  if (apps === null || apps === undefined) return null;
  const slugs: Array<string> = [];
  for (const value of apps) {
    const slug = normaliseAppSlug(value);
    if (slug !== null && !slugs.includes(slug)) slugs.push(slug);
  }
  return slugs.length === 0 ? null : slugs.slice(0, 8);
}

/** The apps column's JSON, read back; a damaged value reads as global (never as unreachable). */
export function parseAppsJson(json: string | null | undefined): ReadonlyArray<string> | null {
  if (json === null || json === undefined || json.length === 0) return null;
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value)
      ? normaliseApps(value.filter((item): item is string => typeof item === "string"))
      : null;
  } catch {
    return null;
  }
}

export const appsToJson = (apps: ReadonlyArray<string> | null | undefined): string | null => {
  const clean = normaliseApps(apps);
  return clean === null ? null : JSON.stringify(clean);
};

export const appLabel = (slug: string): string => APP_BY_SLUG.get(slug)?.label ?? slug;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const aliasPattern = (alias: string): RegExp => {
  const words = alias
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map(escapeRegExp);
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.join("[\\s_-]?")}(?![\\p{L}\\p{N}])`, "iu");
};

const patternCache = new Map<string, ReadonlyArray<RegExp>>();

const patternsFor = (slug: string): ReadonlyArray<RegExp> => {
  const cached = patternCache.get(slug);
  if (cached !== undefined) return cached;
  const names = new Set<string>([slug, ...(APP_BY_SLUG.get(slug)?.aliases ?? [])]);
  const patterns = [...names].map(aliasPattern);
  patternCache.set(slug, patterns);
  return patterns;
};

/** Whether the text names the app (its slug or any alias, as whole words). */
export function mentionsApp(text: string, slug: string): boolean {
  return text.length > 0 && patternsFor(slug).some((pattern) => pattern.test(text));
}

/** What a turn is about: the signals the active apps are read from. */
export interface AppSignals {
  /** The chat's title. */
  readonly title?: string | undefined;
  /** The message that starts this turn (a task brief for delegated work). */
  readonly current: string;
  /** The last few messages before it, newest first. */
  readonly recent?: ReadonlyArray<string> | undefined;
  /** The bot's name and description: only an obvious role names an app. */
  readonly botRole?: string | undefined;
}

export interface ActiveApp {
  readonly slug: string;
  /** Where it was found: title, message, recent, role. */
  readonly via: ReadonlyArray<"title" | "message" | "recent" | "role">;
}

/** Messages before the current one that count, each read up to this long. */
export const APP_SIGNAL_RECENT_MESSAGES = 4;
export const APP_SIGNAL_RECENT_CHARS = 1_500;
/** Most apps one turn is about: bounds how many rule groups a turn can add. */
export const MAX_ACTIVE_APPS = 4;

/**
 * The apps this turn is about, among those any rule is scoped to (plus the
 * registered apps): found by name in the chat title, the message or brief, the
 * last few messages, and the bot's own name or description. Strong signals
 * (title, message) first; at most {@link MAX_ACTIVE_APPS}.
 */
export function detectActiveApps(
  signals: AppSignals,
  ruleApps: ReadonlyArray<string> = [],
): ReadonlyArray<ActiveApp> {
  const slugs = [...new Set([...MEMORY_APPS.map((app) => app.slug), ...ruleApps])];
  const title = signals.title ?? "";
  const current = signals.current.slice(0, 8_000);
  const recent = (signals.recent ?? [])
    .slice(0, APP_SIGNAL_RECENT_MESSAGES)
    .map((text) => text.slice(0, APP_SIGNAL_RECENT_CHARS));
  const role = signals.botRole ?? "";
  const found: Array<ActiveApp & { readonly rank: number }> = [];
  for (const slug of slugs) {
    const via: Array<ActiveApp["via"][number]> = [];
    if (mentionsApp(title, slug)) via.push("title");
    if (mentionsApp(current, slug)) via.push("message");
    if (recent.some((text) => mentionsApp(text, slug))) via.push("recent");
    if (mentionsApp(role, slug)) via.push("role");
    if (via.length === 0) continue;
    const rank =
      via.includes("title") || via.includes("message") ? 0 : via.includes("role") ? 1 : 2;
    found.push({ slug, via, rank });
  }
  return found
    .toSorted((a, b) => a.rank - b.rank)
    .slice(0, MAX_ACTIVE_APPS)
    .map(({ slug, via }) => ({ slug, via }));
}

/** What is needed of a rule to pick and cap it. */
export interface RuleLike {
  readonly memoryId: string;
  readonly content: string;
  readonly apps: ReadonlyArray<string> | null;
}

export interface RuleCaps {
  readonly maxEntries: number;
  readonly maxChars: number;
}

export interface AppIndexGroup {
  readonly slug: string;
  readonly label: string;
  readonly count: number;
}

export interface RuleSelection<T extends RuleLike> {
  /** Rules to list, in the order given (newest first in, so reverse for display). */
  readonly kept: ReadonlyArray<T>;
  /** Rules for apps not active this turn: counted in the index, not listed. */
  readonly indexed: ReadonlyArray<T>;
  readonly index: ReadonlyArray<AppIndexGroup>;
  /** Rules of an active app, or global, that did not fit the caps: named in the block. */
  readonly leftOut: ReadonlyArray<T>;
  /** Of the caps, how full the listed rules are (0 to 1, may pass 1 with only global rules). */
  readonly fill: { readonly entries: number; readonly chars: number };
}

const dedupeKey = (content: string) => content.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Picks a turn's rules from every rule the bot can see, newest first.
 *
 * - Global rules (no apps) are always kept, whatever the caps say.
 * - A rule of an active app is kept while it fits the caps; once one does not
 *   fit, it and every older app rule are left out (a shorter older rule never
 *   jumps the queue) and reported in `leftOut`, never dropped silently.
 * - Rules of other apps are counted per app in `index`.
 * - With `scoping` false every rule is treated as global (the old behaviour,
 *   minus the old silent drops: only the caps decide, newest first).
 */
export function selectRules<T extends RuleLike>(
  newestFirst: ReadonlyArray<T>,
  input: {
    readonly active: ReadonlySet<string>;
    readonly caps: RuleCaps;
    readonly scoping: boolean;
  },
): RuleSelection<T> {
  const seen = new Set<string>();
  const unique: Array<T> = [];
  for (const rule of newestFirst) {
    const key = dedupeKey(rule.content);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(rule);
  }
  const isGlobal = (rule: T) => !input.scoping || rule.apps === null;
  const globals = unique.filter(isGlobal);
  const scoped = unique.filter((rule) => !isGlobal(rule));
  const isActive = (rule: T) => rule.apps!.some((app) => input.active.has(app));
  const wanted = scoped.filter(isActive);
  const indexed = scoped.filter((rule) => !isActive(rule));

  const keptIds = new Set(globals.map((rule) => rule.memoryId));
  let entries = globals.length;
  let chars = globals.reduce((total, rule) => total + rule.content.length, 0);
  const leftOut: Array<T> = [];
  let full = false;
  for (const rule of wanted) {
    if (
      full ||
      entries >= input.caps.maxEntries ||
      chars + rule.content.length > input.caps.maxChars
    ) {
      full = true;
      leftOut.push(rule);
      continue;
    }
    keptIds.add(rule.memoryId);
    entries += 1;
    chars += rule.content.length;
  }
  const counts = new Map<string, number>();
  for (const rule of indexed) {
    for (const app of rule.apps!) counts.set(app, (counts.get(app) ?? 0) + 1);
  }
  const index = [...counts]
    .map(([slug, count]) => ({ slug, label: appLabel(slug), count }))
    .toSorted((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return {
    kept: unique.filter((rule) => keptIds.has(rule.memoryId)),
    indexed,
    index,
    leftOut,
    fill: { entries: entries / input.caps.maxEntries, chars: chars / input.caps.maxChars },
  };
}

/** "Matchday: 5 rules, CalTrack: 1 rule": the groups of rules not listed this turn. */
export function formatAppIndex(index: ReadonlyArray<AppIndexGroup>): string | null {
  if (index.length === 0) return null;
  return index
    .map((group) => `${group.label}: ${group.count} ${group.count === 1 ? "rule" : "rules"}`)
    .join(", ");
}
