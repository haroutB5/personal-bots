/**
 * When a DeepSeek prepaid balance is worth interrupting the owner for.
 *
 * Warn at or below $1.00 and re-arm only above $1.50. A single threshold
 * would flap a notice every time the balance crossed a dollar; the gap means
 * one notice per low spell, cleared by a top-up.
 *
 * Inside one spell the notice escalates once: the low notice, then the
 * stronger empty notice when the account runs out. It never falls back to low
 * and never repeats.
 *
 * A failed read never warns and never re-arms. An outage must not present
 * itself as a balance problem, and it must not end a spell either, or a flaky
 * poll would produce a second notice for the same drop.
 *
 * Only a USD reading is judged. DeepSeek reports the account's own currency
 * and the app never converts or invents a rate.
 *
 * @module personal/deepseek/deepSeekBalanceAlert
 */
import { PROVIDER_LOW_BALANCE_REARM_USD, PROVIDER_LOW_BALANCE_USD } from "@t3tools/contracts";
import type { DeepSeekBalanceRead } from "@t3tools/provider-deepseek/server";

/** At or below this (USD) the owner is told. Shared with the card's warning line. */
export const DEEPSEEK_LOW_BALANCE_USD = PROVIDER_LOW_BALANCE_USD;
/** A low spell ends, and can be reported again, above this (USD). */
export const DEEPSEEK_LOW_BALANCE_REARM_USD = PROVIDER_LOW_BALANCE_REARM_USD;
/** At most one turn-triggered check per instance in this window. */
export const DEEPSEEK_BALANCE_CHECK_DEBOUNCE_MS = 5 * 60_000;
/** The light timer's cadence while an enabled DeepSeek instance has a key. */
export const DEEPSEEK_BALANCE_CHECK_INTERVAL_MS = 30 * 60_000;

/** One `personal_meta` row per instance holds the announced kind. */
export const deepSeekBalanceAlertMetaKey = (instanceId: string) =>
  `deepseek-balance-low:${instanceId}`;

export type DeepSeekBalanceAlertKind = "low" | "empty";

/** The notice already sent in the open spell, or null when no spell is open. */
export type DeepSeekBalanceAlertLastKind = DeepSeekBalanceAlertKind | null;

export interface DeepSeekBalanceAlert {
  readonly kind: DeepSeekBalanceAlertKind;
  /** The balance as the notice names it, e.g. `$0.94`. */
  readonly balance: string;
}

export type DeepSeekBalanceAlertDecision =
  | { readonly action: "none" }
  /** Above the re-arm line: the low spell is over, forget it. */
  | { readonly action: "clear" }
  | { readonly action: "alert"; readonly alert: DeepSeekBalanceAlert };

/** Money as the notice names it: two decimals, `$` only for USD. */
export function formatDeepSeekBalance(amounts: {
  readonly currency: string;
  readonly totalBalance: number;
}): string {
  const total = Math.round(amounts.totalBalance * 100) / 100;
  const fixed = total.toFixed(2);
  return amounts.currency.toUpperCase() === "USD" ? `$${fixed}` : `${amounts.currency} ${fixed}`;
}

/** What to do about one reading, given what this instance already announced. */
export function decideDeepSeekBalanceAlert(input: {
  readonly read: DeepSeekBalanceRead;
  readonly lastKind: DeepSeekBalanceAlertLastKind;
}): DeepSeekBalanceAlertDecision {
  if (input.read.status !== "ready") return { action: "none" };
  const { amounts } = input.read;
  if (amounts.currency.toUpperCase() !== "USD") return { action: "none" };
  if (amounts.totalBalance > DEEPSEEK_LOW_BALANCE_REARM_USD) {
    return input.lastKind !== null ? { action: "clear" } : { action: "none" };
  }
  // The band between the warn line and the re-arm line keeps the spell as it is.
  if (amounts.totalBalance > DEEPSEEK_LOW_BALANCE_USD) return { action: "none" };
  const empty = !amounts.isAvailable || amounts.totalBalance <= 0;
  const allowed = input.lastKind === null || (input.lastKind === "low" && empty);
  if (!allowed) return { action: "none" };
  return {
    action: "alert",
    alert: { kind: empty ? "empty" : "low", balance: formatDeepSeekBalance(amounts) },
  };
}

/**
 * The persisted flag: the kind already announced in the open spell, or null.
 * Anything absent or unreadable counts as "nothing announced": one notice too
 * many is a smaller harm than never telling the owner the account is running
 * dry.
 */
export function parseDeepSeekBalanceLastKind(
  value: string | undefined,
): DeepSeekBalanceAlertLastKind {
  if (value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const kind = (parsed as { readonly kind?: unknown }).kind;
    if (kind === "low" || kind === "empty") return kind;
    // 1.66.43 stored a bare boolean, and only for the first notice of a spell.
    return (parsed as { readonly warned?: unknown }).warned === true ? "low" : null;
  } catch {
    return null;
  }
}

/** The value stored under {@link deepSeekBalanceAlertMetaKey}. */
export function deepSeekBalanceLastKindValue(input: {
  readonly kind: DeepSeekBalanceAlertLastKind;
  readonly at: string;
  readonly balance?: string;
}): string {
  return JSON.stringify({
    // `warned` carries the same fact for the QA and diagnostic probes written
    // before `kind` existed.
    kind: input.kind,
    warned: input.kind !== null,
    at: input.at,
    ...(input.balance !== undefined ? { balance: input.balance } : {}),
  });
}
