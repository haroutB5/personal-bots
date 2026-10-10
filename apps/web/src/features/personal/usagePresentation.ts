import type {
  ProviderConsumeResetCreditInput,
  ServerProvider,
  ServerProviderResetCredits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { formatDuration, limitsNotice } from "@t3tools/shared/usageLimits";

import { formatUsd } from "./tokenUsagePresentation";

/** Drivers surfaced as cards, in display order. */
export const USAGE_CARD_DRIVERS = ["claudeAgent", "codex", "deepseek"] as const;
export type UsageCardDriver = (typeof USAGE_CARD_DRIVERS)[number];

export const USAGE_CARD_TITLES: Record<UsageCardDriver, string> = {
  claudeAgent: "Claude",
  codex: "Codex",
  deepseek: "DeepSeek",
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
  /**
   * Bars to draw: the provider's last known windows, however old (`checkedAt`
   * says how old), even while a probe runs or after one failed. Individual
   * missing rows still read "not reported".
   */
  | "ready"
  /** No windows, and asking again will not help: API-key style account, or signed out. */
  | "unavailable"
  /** Never read: no reading has ever come back for this provider. */
  | "not-reported";

export interface UsageCard {
  readonly driver: UsageCardDriver;
  readonly title: string;
  /** Plan label from provider auth, when the server names one. */
  readonly plan: string | undefined;
  readonly status: UsageCardStatus;
  /** Why there are no bars (unavailable message, signed out, or the probe's reason). */
  readonly notice: string | null;
  /**
   * The newest refresh failed while the bars above are an older reading: the
   * short reason, or "" when the server named none. Null when the last
   * refresh did not fail (or there are no bars).
   */
  readonly refreshFailure: string | null;
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
  /**
   * A prepaid balance instead of windows (DeepSeek). Null for every window
   * provider; a card with a balance has no session or weekly rows.
   */
  readonly balance: UsageBalanceView | null;
}

/** The money half of a card: what is left of a prepaid balance. */
export interface UsageBalanceView {
  readonly currency: string;
  readonly total: number;
  readonly granted: number;
  readonly toppedUp: number;
  /** The provider's own answer to "can this account make API calls". */
  readonly isAvailable: boolean;
  /** Epoch millis the provider returned these numbers, or null when unparseable. */
  readonly fetchedAt: number | null;
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

/** First sentence of a provider message, for a one-line reason. */
function firstSentence(message: string | undefined): string | null {
  const text = message?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(text)?.[1] ?? text;
  return sentence.replace(/[.!?]+$/, "") || null;
}

/**
 * Why a provider that has never been read shows no bars, said plainly: signed
 * out, the API-key kind of account, the probe's own failure, else null (a
 * probe has simply not come back yet).
 */
function placeholderNotice(provider: ServerProvider, title: string): string | null {
  const limits = provider.usageLimits;
  if (limits?.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? "This account has no subscription limits.";
  }
  if (provider.auth.status === "unauthenticated") {
    return `Not signed in to ${title}. Sign in on this computer to see usage.`;
  }
  if (limits?.unavailable?.reason === "probeFailed") {
    return (
      limits.unavailable.message ?? firstSentence(provider.message) ?? "Could not read limits."
    );
  }
  if (provider.status === "error") {
    return firstSentence(provider.message) ?? `${title} could not be checked.`;
  }
  if (limits !== undefined && limits.windows.length === 0) return limitsNotice(limits);
  return null;
}

/**
 * One card per driver (Claude, Codex, DeepSeek) from the providers the config
 * stream already publishes. Drivers with no configured instance get no card.
 *
 * A provider with windows always shows them: the server keeps the last good
 * reading through a failed probe, a restart and a first probe still running,
 * so the card says how old it is and, when the newest refresh failed, why.
 * Only a provider never read falls back to `unavailable` or `not-reported`,
 * with the reason, and never 0%.
 *
 * DeepSeek has no windows: its card is the prepaid balance, with the same
 * keep-the-last-good behaviour behind it (the server keeps the numbers and
 * marks the newest read failed), and no balance at all when the key is
 * missing, which is final until one is added.
 */
export function selectUsageCards(
  providers: ReadonlyArray<ServerProvider>,
  now: number,
): readonly UsageCard[] {
  const cards: UsageCard[] = [];
  for (const driver of USAGE_CARD_DRIVERS) {
    const provider = newestInstance(providers, driver);
    if (!provider) continue;
    const title = USAGE_CARD_TITLES[driver];
    if (driver === "deepseek") {
      cards.push(deepSeekCard(provider, title));
      continue;
    }
    const limits = provider.usageLimits;
    if (limits && limits.unavailable?.reason !== "unsupported" && limits.windows.length > 0) {
      const failure =
        limits.refreshFailed !== undefined
          ? (limits.refreshFailed.message ?? "")
          : limits.unavailable?.reason === "probeFailed"
            ? (limits.unavailable.message ?? "")
            : null;
      cards.push({
        driver,
        title,
        plan: provider.auth.label,
        status: "ready",
        notice: null,
        refreshFailure: failure,
        session: pickSession(limits.windows, now),
        weeklies: pickWeeklies(limits.windows, now),
        checkedAt: parseCheckedAt(limits.checkedAt),
        resetCredits: limits.resetCredits
          ? { credits: limits.resetCredits, input: { instanceId: provider.instanceId } }
          : null,
        balance: null,
      });
      continue;
    }
    const notice = placeholderNotice(provider, title);
    const final =
      limits?.unavailable?.reason === "unsupported" || provider.auth.status === "unauthenticated";
    cards.push({
      driver,
      title,
      plan: provider.auth.label,
      status: final ? "unavailable" : "not-reported",
      notice,
      refreshFailure: null,
      session: null,
      weeklies: [],
      checkedAt: parseCheckedAt(limits?.checkedAt),
      resetCredits: null,
      balance: null,
    });
  }
  return cards;
}

/**
 * The DeepSeek card: the prepaid balance, or the quiet reason there is none.
 *
 * A reading keeps showing while the newest one fails (the server sends the
 * last good numbers with `status: "failed"`), so `refreshFailure` says the
 * refresh failed exactly as it does over kept windows. No reading at all is
 * final only without a key (nothing can ever be read until one is added),
 * which keeps the strip's own probing from asking forever.
 */
function deepSeekCard(provider: ServerProvider, title: string): UsageCard {
  const usageBalance = provider.usageBalance;
  // The server writes `balance` only when it has numbers to show: the newest
  // reading when it succeeded, the last good one when it did not.
  const reading = usageBalance?.balance;
  const failure = usageBalance?.status === "failed" ? (usageBalance.message ?? "") : null;
  const checkedAt = parseCheckedAt(usageBalance?.checkedAt);
  if (reading !== undefined) {
    return {
      driver: "deepseek",
      title,
      plan: undefined,
      status: "ready",
      notice: null,
      refreshFailure: failure,
      session: null,
      weeklies: [],
      checkedAt,
      resetCredits: null,
      balance: {
        currency: reading.currency,
        total: reading.totalBalance,
        granted: reading.grantedBalance,
        toppedUp: reading.toppedUpBalance,
        isAvailable: reading.isAvailable,
        fetchedAt: parseCheckedAt(reading.fetchedAt),
      },
    };
  }
  const noKey = provider.auth.status === "unauthenticated";
  return {
    driver: "deepseek",
    title,
    plan: undefined,
    status: noKey ? "unavailable" : "not-reported",
    // No reading and no failure yet: leave the notice empty so the sheet's own
    // "Checking…" / "not read yet" wording covers the first probe.
    notice: noKey ? "No DeepSeek API key. Add one on the DeepSeek instance in Settings." : failure,
    refreshFailure: null,
    session: null,
    weeklies: [],
    checkedAt,
    resetCredits: null,
    balance: null,
  };
}

/**
 * A money figure in the provider's own currency: `$12.34` for USD, short
 * where the amount is large; anything else is shown with its own code
 * (`12.34 CNY`), never converted behind the owner's back.
 */
export function formatBalanceAmount(amount: number, currency: string): string {
  const value = Number.isFinite(amount) ? amount : 0;
  const code = currency.trim().toUpperCase();
  return code === "USD" ? formatUsd(value) : `${value.toFixed(2)} ${code || currency}`;
}

/** "Couldn't refresh" (the server named no reason) or "Couldn't refresh · <reason>". */
export function refreshFailureText(failure: string | null): string | null {
  if (failure === null) return null;
  return failure === "" ? "Couldn't refresh" : `Couldn't refresh · ${failure}`;
}

/** "Couldn't refresh · <reason>" for a card showing an older reading, else null. */
export function usageRefreshFailureText(card: UsageCard): string | null {
  return refreshFailureText(card.refreshFailure);
}

/** The DeepSeek balance line the Team screen shows under its totals. */
export interface UsageBalanceLine {
  readonly balance: UsageBalanceView;
  /** The newest balance read failed; the numbers are the last good ones. */
  readonly failure: string | null;
}

/**
 * The balance line for the Team token usage card, or null when there is no
 * DeepSeek instance, no key, or no reading yet. Same selection as the usage
 * sheet's own DeepSeek card, so both surfaces agree on what is shown.
 */
export function selectDeepSeekBalanceLine(
  providers: ReadonlyArray<ServerProvider>,
  now: number,
): UsageBalanceLine | null {
  const card = selectUsageCards(providers, now).find((entry) => entry.driver === "deepseek");
  return card?.balance ? { balance: card.balance, failure: card.refreshFailure } : null;
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
 * The Bots list's own first reading. The server probes usage once at startup
 * and then on its five-minute cadence, but a startup probe that could not read
 * usage (the CLI is cold, the machine busy) leaves every bar reading "Not
 * reported" and doubles the wait for the next probe, so after a restart the
 * strip could stay empty for ten minutes until the sheet was opened (the
 * sheet probes on open). The list asks for the same probe itself:
 *
 * - whenever a card has no reading at all (the state right after such a
 *   restart, and a server that restarts under an open page), even when that
 *   failed probe was only seconds ago;
 * - on the first load of the app, a card whose reading is past a minute, by
 *   the sheet's rule ({@link usageNeedsRefreshOnOpen}); never because a good
 *   reading aged later: the server's own cadence keeps those fresh;
 * - never twice within one server probe interval, so a probe that keeps
 *   failing costs one attempt per interval, not one per render.
 */
export const USAGE_AUTO_PROBE_MIN_GAP_MS = 5 * 60_000;

export function usageAutoProbeDue(input: {
  readonly cards: readonly UsageCard[];
  readonly now: number;
  /** When this page last asked for a probe on its own, or null if it has not. */
  readonly lastProbeAt: number | null;
  /** True until the first providers have been looked at on this page. */
  readonly firstLoad: boolean;
}): boolean {
  if (input.cards.length === 0) return false;
  if (input.lastProbeAt !== null && input.now - input.lastProbeAt < USAGE_AUTO_PROBE_MIN_GAP_MS) {
    return false;
  }
  // A probe that failed just now still carries a fresh `checkedAt`, so the
  // sheet's staleness rule alone would call it current: a card with no
  // reading, or one whose newest refresh failed, is due whenever it is seen.
  if (input.cards.some((card) => card.status === "not-reported" || card.refreshFailure !== null)) {
    return true;
  }
  return input.firstLoad && usageNeedsRefreshOnOpen(input.cards, input.now);
}

/**
 * What a card that has never been read should say (a card with a reading keeps
 * its bars; see `selectUsageCards`).
 *
 * A probe in flight says so rather than reporting an absence as a fact: the
 * two are indistinguishable in the snapshot, and only one of them is something
 * the owner can act on. A reason the provider gave (signed out, the probe's
 * failure) is shown as it is, not hidden behind "Checking…" once it is known.
 */
export function usageCardEmptyText(
  card: UsageCard,
  options: { readonly checking: boolean },
): string {
  if (card.status === "unavailable") {
    return card.notice ?? "This account has no subscription limits.";
  }
  if (options.checking && card.notice === null) return "Checking…";
  return card.notice ?? "Not read yet. Usage shows once the first check finishes.";
}
