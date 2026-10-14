import { describe, expect, it } from "vite-plus/test";

import type { DeepSeekBalanceRead } from "../../provider/Drivers/DeepSeekBalance.ts";
import {
  DEEPSEEK_LOW_BALANCE_USD,
  DEEPSEEK_LOW_BALANCE_REARM_USD,
  decideDeepSeekBalanceAlert,
  deepSeekBalanceAlertMetaKey,
  deepSeekBalanceWarnedValue,
  formatDeepSeekBalance,
  parseDeepSeekBalanceWarned,
} from "./deepSeekBalanceAlert.ts";

function ready(input: {
  readonly totalBalance: number;
  readonly currency?: string;
  readonly isAvailable?: boolean;
}): DeepSeekBalanceRead {
  return {
    status: "ready",
    fetchedAtMs: 1_000_000,
    amounts: {
      currency: input.currency ?? "USD",
      totalBalance: input.totalBalance,
      grantedBalance: 0,
      toppedUpBalance: input.totalBalance,
      isAvailable: input.isAvailable ?? true,
    },
  };
}

const failed: DeepSeekBalanceRead = {
  status: "failed",
  reason: "network_error",
  lastGood: null,
};

const decide = (read: DeepSeekBalanceRead, warned = false) =>
  decideDeepSeekBalanceAlert({ read, warned });

describe("decideDeepSeekBalanceAlert", () => {
  it("warns at exactly a dollar and not a cent above it", () => {
    expect(DEEPSEEK_LOW_BALANCE_USD).toBe(1);
    expect(decide(ready({ totalBalance: 1 }))).toEqual({
      action: "alert",
      alert: { kind: "low", balance: "$1.00" },
    });
    expect(decide(ready({ totalBalance: 1.01 }))).toEqual({ action: "none" });
    expect(decide(ready({ totalBalance: 0.94 }))).toEqual({
      action: "alert",
      alert: { kind: "low", balance: "$0.94" },
    });
  });

  it("re-arms above 1.50 only, so a balance near a dollar cannot flap", () => {
    expect(DEEPSEEK_LOW_BALANCE_REARM_USD).toBe(1.5);
    // Still inside the band: the spell is neither ended nor reported again.
    expect(decide(ready({ totalBalance: 1.2 }), true)).toEqual({ action: "none" });
    expect(decide(ready({ totalBalance: 1.5 }), true)).toEqual({ action: "none" });
    expect(decide(ready({ totalBalance: 1.51 }), true)).toEqual({ action: "clear" });
    // Nothing to clear when the balance was never in a low spell.
    expect(decide(ready({ totalBalance: 1.51 }), false)).toEqual({ action: "none" });
  });

  it("warns once per spell", () => {
    expect(decide(ready({ totalBalance: 0.94 }), true)).toEqual({ action: "none" });
    expect(decide(ready({ totalBalance: 0 }), true)).toEqual({ action: "none" });
  });

  it("says empty at zero or when the account cannot make calls", () => {
    expect(decide(ready({ totalBalance: 0 }))).toEqual({
      action: "alert",
      alert: { kind: "empty", balance: "$0.00" },
    });
    expect(decide(ready({ totalBalance: 0.4, isAvailable: false }))).toEqual({
      action: "alert",
      alert: { kind: "empty", balance: "$0.40" },
    });
  });

  it("never warns on a failed read, and never ends a spell on one either", () => {
    expect(decide(failed)).toEqual({ action: "none" });
    // The important half: an outage must not re-arm, or the next good reading
    // would report the same drop a second time.
    expect(decide(failed, true)).toEqual({ action: "none" });
  });

  it("leaves a non-USD account alone rather than measuring it against a dollar", () => {
    expect(decide(ready({ totalBalance: 6, currency: "CNY" }))).toEqual({ action: "none" });
    expect(decide(ready({ totalBalance: 0.2, currency: "CNY" }), true)).toEqual({ action: "none" });
  });
});

describe("the balance wording and the persisted flag", () => {
  it("names money the way the notice does", () => {
    expect(formatDeepSeekBalance({ currency: "USD", totalBalance: 0.94 })).toBe("$0.94");
    expect(formatDeepSeekBalance({ currency: "usd", totalBalance: 1 })).toBe("$1.00");
    expect(formatDeepSeekBalance({ currency: "CNY", totalBalance: 6 })).toBe("CNY 6.00");
    // Never rounded up into a bigger number than the account holds.
    expect(formatDeepSeekBalance({ currency: "USD", totalBalance: 0.999 })).toBe("$1.00");
  });

  it("reads an unreadable flag as not warned, and round-trips its own value", () => {
    expect(parseDeepSeekBalanceWarned(undefined)).toBe(false);
    expect(parseDeepSeekBalanceWarned("")).toBe(false);
    expect(parseDeepSeekBalanceWarned("not json")).toBe(false);
    expect(parseDeepSeekBalanceWarned("null")).toBe(false);
    expect(parseDeepSeekBalanceWarned("[]")).toBe(false);
    expect(parseDeepSeekBalanceWarned('{"warned":false}')).toBe(false);
    expect(parseDeepSeekBalanceWarned('{"warned":true}')).toBe(true);
    expect(
      parseDeepSeekBalanceWarned(
        deepSeekBalanceWarnedValue({ warned: true, at: "2026-10-14T10:00:00Z", balance: "$0.94" }),
      ),
    ).toBe(true);
    expect(
      parseDeepSeekBalanceWarned(
        deepSeekBalanceWarnedValue({ warned: false, at: "2026-10-14T10:00:00Z" }),
      ),
    ).toBe(false);
  });

  it("namespaces the flag by instance, like the smoke check", () => {
    expect(deepSeekBalanceAlertMetaKey("deepseek")).toBe("deepseek-balance-low:deepseek");
  });
});
