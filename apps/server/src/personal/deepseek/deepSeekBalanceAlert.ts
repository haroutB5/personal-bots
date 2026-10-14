/**
 * When a DeepSeek prepaid balance is worth interrupting the owner for.
 *
 * Two thresholds, deliberately: warn at or below $1.00, and re-arm only once
 * the balance is back above $1.50. A single threshold would flap a
 * notification every time the balance crossed a dollar; the gap means one
 * notice per low spell, cleared by a top-up.
 *
 * A failed read never warns and never re-arms. An outage must not present
 * itself as a balance problem (Harout's rule: nothing that makes it look like
 * something is wrong when it is not), and it must not end a low spell either,
 * because then a flaky poll would produce a second notice for the same drop.
 *
 * Only a USD reading is judged. DeepSeek reports the account's own currency
 * and the app never converts or invents a rate, so a CNY-only account is left
 * alone rather than measured against a dollar line.
 *
 * @module personal/deepseek/deepSeekBalanceAlert
 */
import { PROVIDER_LOW_BALANCE_REARM_USD, PROVIDER_LOW_BALANCE_USD } from "@t3tools/contracts";

import type { DeepSeekBalanceRead } from "../../provider/Drivers/DeepSeekBalance.ts";

/**
 * At or below this (USD) the owner is told. The threshold lives in the shared
 * contract so the card's warning line and this notice can never disagree.
 */
export const DEEPSEEK_LOW_BALANCE_USD = PROVIDER_LOW_BALANCE_USD;
/** A low spell ends, and can be reported again, above this (USD). */
export const DEEPSEEK_LOW_BALANCE_REARM_USD = PROVIDER_LOW_BALANCE_REARM_USD;
/** At most one turn-triggered check per instance in this window. */
export const DEEPSEEK_BALANCE_CHECK_DEBOUNCE_MS = 5 * 60_000;
/** The light timer's cadence while an enabled DeepSeek instance has a key. */
export const DEEPSEEK_BALANCE_CHECK_INTERVAL_MS = 30 * 60_000;

/**
 * Where the warned flag lives: one `personal_meta` row per instance, like
 * `provider-smoke-check:<instanceId>`.
 */
export const deepSeekBalanceAlertMetaKey = (instanceId: string) =>
  `deepseek-balance-low:${instanceId}`;

export type DeepSeekBalanceAlertKind = "low" | "empty";

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

/**
 * What to do about one reading, given whether this instance is already inside a
 * reported low spell.
 */
export function decideDeepSeekBalanceAlert(input: {
  readonly read: DeepSeekBalanceRead;
  readonly warned: boolean;
}): DeepSeekBalanceAlertDecision {
  if (input.read.status !== "ready") return { action: "none" };
  const { amounts } = input.read;
  if (amounts.currency.toUpperCase() !== "USD") return { action: "none" };
  if (amounts.totalBalance > DEEPSEEK_LOW_BALANCE_REARM_USD) {
    return input.warned ? { action: "clear" } : { action: "none" };
  }
  // The band between the warn line and the re-arm line keeps the spell as it
  // is: still warned stays quiet, not yet warned stays quiet too.
  if (amounts.totalBalance > DEEPSEEK_LOW_BALANCE_USD) return { action: "none" };
  if (input.warned) return { action: "none" };
  const empty = !amounts.isAvailable || amounts.totalBalance <= 0;
  return {
    action: "alert",
    alert: { kind: empty ? "empty" : "low", balance: formatDeepSeekBalance(amounts) },
  };
}

/**
 * The persisted warned flag. Anything absent or unreadable counts as "not
 * warned": one notice too many is a smaller harm than never telling the owner
 * the account is running dry.
 */
export function parseDeepSeekBalanceWarned(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    return (parsed as { readonly warned?: unknown }).warned === true;
  } catch {
    return false;
  }
}

/** The value stored under {@link deepSeekBalanceAlertMetaKey}. */
export function deepSeekBalanceWarnedValue(input: {
  readonly warned: boolean;
  readonly at: string;
  readonly balance?: string;
}): string {
  return JSON.stringify({
    warned: input.warned,
    at: input.at,
    ...(input.balance !== undefined ? { balance: input.balance } : {}),
  });
}
