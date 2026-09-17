import { TurnId, type OrchestrationSession } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decideTurnRetry,
  PERSONAL_TURN_RETRY_DELAYS_MS,
  PERSONAL_TURN_RETRY_MAX_ATTEMPTS,
  type TrackedTurn,
} from "./personalTurnRetryPolicy.ts";

const UPSTREAM_FAILURE =
  "Error from provider (Console): Upstream request failed: Endpoint is unavailable.";

const session = (
  overrides: Partial<OrchestrationSession> = {},
): Pick<OrchestrationSession, "status" | "lastError" | "activeTurnId" | "providerRetry"> => ({
  status: "error",
  lastError: UPSTREAM_FAILURE,
  activeTurnId: null,
  ...overrides,
});

const ownerTurn = (attempts: number): TrackedTurn => ({ taskDriven: false, attempts });

describe("decideTurnRetry", () => {
  it("retries a transient failure on the owner's own turn", () => {
    expect(decideTurnRetry({ session: session(), tracked: ownerTurn(0) })).toEqual({
      kind: "retry",
      attempt: 1,
      delayMs: PERSONAL_TURN_RETRY_DELAYS_MS[0],
    });
  });

  it("waits longer before the second attempt", () => {
    expect(decideTurnRetry({ session: session(), tracked: ownerTurn(1) })).toEqual({
      kind: "retry",
      attempt: 2,
      delayMs: PERSONAL_TURN_RETRY_DELAYS_MS[1],
    });
    expect(PERSONAL_TURN_RETRY_DELAYS_MS[1]).toBeGreaterThan(PERSONAL_TURN_RETRY_DELAYS_MS[0]!);
  });

  it("stops once the attempts are spent, however long the outage lasts", () => {
    expect(
      decideTurnRetry({ session: session(), tracked: ownerTurn(PERSONAL_TURN_RETRY_MAX_ATTEMPTS) }),
    ).toEqual({ kind: "exhausted" });
    // A dead provider must cost a bounded number of billed runs, not a loop.
    expect(decideTurnRetry({ session: session(), tracked: ownerTurn(50) })).toEqual({
      kind: "exhausted",
    });
  });

  it.each([
    ["a usage limit", "You've hit your session limit · resets 10:10pm (Europe/London)"],
    ["a rate limit", "API Error: 429 rate_limit_error"],
    ["a sign-in failure", "Error: Not logged in · Please run /login"],
    ["a missing model", "model not found: claude-does-not-exist"],
    ["an invalid request", "400 Bad Request: invalid_request_error"],
    ["a turn the owner stopped", "Turn aborted by user"],
    ["an unrecognised failure", "something nobody has seen before"],
  ])("never retries %s", (_label, lastError) => {
    expect(decideTurnRetry({ session: session({ lastError }), tracked: ownerTurn(0) })).toEqual({
      kind: "skip",
      reason: "not_transient",
    });
  });

  it("never retries while the provider itself is holding a rate-limit wait", () => {
    const decision = decideTurnRetry({
      session: session({
        providerRetry: {
          kind: "rate_limited",
          provider: "claude",
          observedAt: "2026-09-17T10:00:00.000Z",
        },
      }),
      tracked: ownerTurn(0),
    });
    expect(decision).toEqual({ kind: "skip", reason: "provider_rate_limited" });
  });

  it("leaves a task or routine turn to its own attempt ledger", () => {
    expect(
      decideTurnRetry({ session: session(), tracked: { taskDriven: true, attempts: 0 } }),
    ).toEqual({ kind: "skip", reason: "task_driven" });
  });

  it("fails closed on a turn it never saw start", () => {
    expect(decideTurnRetry({ session: session(), tracked: null })).toEqual({
      kind: "skip",
      reason: "turn_not_tracked",
    });
  });

  it("ignores its own marker coming back round the event loop", () => {
    const decision = decideTurnRetry({
      session: session({
        providerRetry: {
          kind: "retrying",
          auto: "pending",
          attempt: 1,
          maxAttempts: 2,
          provider: "claude",
          observedAt: "2026-09-17T10:00:00.000Z",
        },
      }),
      tracked: ownerTurn(0),
    });
    expect(decision).toEqual({ kind: "skip", reason: "already_marked" });
  });

  it.each([
    ["the session is still running", session({ status: "running" })],
    ["the session is healthy", session({ status: "ready", lastError: null })],
    ["a turn is still active", session({ activeTurnId: TurnId.make("turn-1") })],
    ["there is no error text", session({ lastError: null })],
  ])("does nothing when %s", (_label, value) => {
    const decision = decideTurnRetry({ session: value, tracked: ownerTurn(0) });
    expect(decision.kind).toBe("skip");
  });
});
