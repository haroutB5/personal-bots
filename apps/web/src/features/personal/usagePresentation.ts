import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import { formatDuration, limitsNotice } from "@t3tools/shared/usageLimits";

/** Drivers surfaced as cards, in display order. */
export const USAGE_CARD_DRIVERS = ["claudeAgent", "codex"] as const;
export type UsageCardDriver = (typeof USAGE_CARD_DRIVERS)[number];

export const USAGE_CARD_TITLES: Record<UsageCardDriver, string> = {
  claudeAgent: "Claude",
  codex: "Codex",
};

function clampPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)));
}

export interface UsageWindowRow {
  readonly id: string;
  readonly label: string;
  /** Share of quota spent, 0..100 — bars and labels show what is used. */
  readonly usedPercent: number;
  /** Human countdown from `resetsAt`, or null when the window names no reset. */
  readonly resetLabel: string | null;
  /** Local clock time for the reset, with a weekday when it is not today. */
  readonly resetTimeLabel: string | null;
}

export type UsageCardStatus =
  /** Bars to draw. Individual missing rows still read "not reported". */
  | "ready"
  /** API-key style account that can never report windows. */
  | "unavailable"
  /** Probe failed, or the provider reported no windows at all. */
  | "not-reported";

export interface UsageCard {
  readonly driver: UsageCardDriver;
  readonly title: string;
  /** Plan label from provider auth, when the server names one. */
  readonly plan: string | undefined;
  readonly status: UsageCardStatus;
  /** Why there are no bars (unavailable message or probe notice). */
  readonly notice: string | null;
  readonly session: UsageWindowRow | null;
  readonly weeklies: readonly UsageWindowRow[];
  /** Epoch millis the snapshot was checked, or null when unknown. */
  readonly checkedAt: number | null;
}

/**
 * "resets in 2h 13m" from an ISO reset instant. Null when the instant is
 * missing or unparseable; "resets now" once the clock has passed it.
 * (`relativeTime.ts` only formats the past, so the future lives here.)
 */
export function formatResetCountdown(resetsAt: string | undefined, now: number): string | null {
  if (resetsAt === undefined) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return null;
  if (at <= now) return "resets now";
  return `resets in ${formatDuration(at - now)}`;
}

/** "Resets 14:30" today, or "Resets Mon 09:00" on another local day. */
export function formatResetTime(resetsAt: string | undefined, now: number): string | null {
  if (resetsAt === undefined) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return null;
  const reset = new Date(at);
  const today = new Date(now);
  const sameDay =
    reset.getFullYear() === today.getFullYear() &&
    reset.getMonth() === today.getMonth() &&
    reset.getDate() === today.getDate();
  const formatted = new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { weekday: "short" as const }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(reset);
  return `Resets ${formatted}`;
}

function toRow(window: ServerProviderUsageWindow, now: number): UsageWindowRow {
  return {
    id: window.id,
    label: window.label,
    usedPercent: clampPercent(window.usedPercent),
    resetLabel: formatResetCountdown(window.resetsAt, now),
    resetTimeLabel: formatResetTime(window.resetsAt, now),
  };
}

/**
 * Pick the 5-hour session row: the first `session` window, else a window
 * whose id names the five-hour bucket (Claude's `five_hour`).
 */
function pickSession(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  now: number,
): UsageWindowRow | null {
  const direct = windows.find((window) => window.kind === "session");
  const fallback = windows.find((window) => window.id.toLowerCase().includes("five_hour"));
  const match = direct ?? fallback;
  return match ? toRow(match, now) : null;
}

/**
 * All weekly rows in server order, deduped by id: every `weekly` window,
 * else every window whose id names a seven-day bucket (Claude's
 * `seven_day` plus per-model weeklies like `seven_day_fable`).
 */
function pickWeeklies(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  now: number,
): readonly UsageWindowRow[] {
  const direct = windows.filter((window) => window.kind === "weekly");
  const source =
    direct.length > 0
      ? direct
      : windows.filter((window) => {
          const id = window.id.toLowerCase();
          return id.includes("seven_day") || id.includes("week");
        });
  const seen = new Set<string>();
  const rows: UsageWindowRow[] = [];
  for (const window of source) {
    if (seen.has(window.id)) continue;
    seen.add(window.id);
    rows.push(toRow(window, now));
  }
  return rows;
}

function parseCheckedAt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** Newest usable snapshot wins when several instances share a driver. */
function newestInstance(
  providers: ReadonlyArray<ServerProvider>,
  driver: UsageCardDriver,
): ServerProvider | null {
  let best: ServerProvider | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const provider of providers) {
    if (provider.driver !== driver || !provider.enabled || !provider.installed) continue;
    const at = parseCheckedAt(provider.usageLimits?.checkedAt) ?? Number.NEGATIVE_INFINITY;
    if (best === null || at > bestAt) {
      best = provider;
      bestAt = at;
    }
  }
  return best;
}

/**
 * One card per driver (Claude, Codex) from the providers the config stream
 * already publishes. Drivers with no configured instance get no card;
 * everything else degrades to `unavailable` or `not-reported`, never 0%.
 */
export function selectUsageCards(
  providers: ReadonlyArray<ServerProvider>,
  now: number,
): readonly UsageCard[] {
  const cards: UsageCard[] = [];
  for (const driver of USAGE_CARD_DRIVERS) {
    const provider = newestInstance(providers, driver);
    if (!provider) continue;
    const limits = provider.usageLimits;
    const notice = limits ? limitsNotice(limits) : null;
    if (!limits || notice !== null) {
      cards.push({
        driver,
        title: USAGE_CARD_TITLES[driver],
        plan: provider.auth.label,
        status: limits?.unavailable?.reason === "unsupported" ? "unavailable" : "not-reported",
        notice,
        session: null,
        weeklies: [],
        checkedAt: parseCheckedAt(limits?.checkedAt),
      });
      continue;
    }
    cards.push({
      driver,
      title: USAGE_CARD_TITLES[driver],
      plan: provider.auth.label,
      status: "ready",
      notice: null,
      session: pickSession(limits.windows, now),
      weeklies: pickWeeklies(limits.windows, now),
      checkedAt: parseCheckedAt(limits.checkedAt),
    });
  }
  return cards;
}
