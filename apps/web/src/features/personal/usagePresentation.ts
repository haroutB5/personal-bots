import type {
  ProviderConsumeResetCreditInput,
  ServerProvider,
  ServerProviderResetCredits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
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
  /**
   * Banked reset credits and where to redeem them: the native instance the
   * bars come from, the same target upstream's Limits tab uses. Null when the
   * card has no bars or the provider reports no credits.
   */
  readonly resetCredits: UsageCardResetCredits | null;
}

export interface UsageCardResetCredits {
  readonly credits: ServerProviderResetCredits;
  readonly input: ProviderConsumeResetCreditInput;
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

/** "1 reset banked", "2 resets banked". */
export function resetCreditsHeadline(count: number): string {
  return `${count} ${count === 1 ? "reset" : "resets"} banked`;
}

/** "26d 15h" until the next banked credit expires, or null when none is reported. */
export function resetCreditsExpiresIn(
  credits: ServerProviderResetCredits,
  now: number,
): string | null {
  if (credits.nextExpiresAt === undefined) return null;
  const at = Date.parse(credits.nextExpiresAt);
  return Number.isFinite(at) ? formatDuration(at - now) : null;
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
        resetCredits: null,
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
      resetCredits: limits.resetCredits
        ? { credits: limits.resetCredits, input: { instanceId: provider.instanceId } }
        : null,
    });
  }
  return cards;
}

/**
 * Whether opening the sheet should probe before believing what it shows.
 *
 * The sheet renders the provider snapshot the app already had, and a snapshot
 * taken before any probe carries no windows at all — which used to render as
 * "Usage is not reported for this account yet", a claim nobody had checked.
 * Refreshing on open is what made the manual button appear to "fix" it.
 *
 * Old bars are the same claim: the sheet opened on a Claude reading seven
 * hours old ("Updated 7h") and showed it as current until the refresh button
 * was pressed (26 Sep). So any reading past a minute is probed on open.
 *
 * Fresh data is left alone so that reopening the sheet twice in a minute does
 * not spend a probe each time.
 */
export const USAGE_STALE_AFTER_MS = 60_000;

export function usageNeedsRefreshOnOpen(cards: readonly UsageCard[], now: number): boolean {
  if (cards.length === 0) return true;
  return cards.some(
    (card) =>
      card.status !== "unavailable" &&
      (card.checkedAt === null || now - card.checkedAt > USAGE_STALE_AFTER_MS),
  );
}

/**
 * What a card with no bars should say.
 *
 * A probe in flight says so rather than reporting an absence as a fact: the
 * two are indistinguishable in the snapshot, and only one of them is something
 * the owner can act on.
 */
export function usageCardEmptyText(
  card: UsageCard,
  options: { readonly checking: boolean },
): string {
  if (card.status === "unavailable") {
    return card.notice ?? "This account has no subscription limits.";
  }
  if (options.checking) return "Checking…";
  return card.notice ?? "Usage is not reported for this account yet.";
}
