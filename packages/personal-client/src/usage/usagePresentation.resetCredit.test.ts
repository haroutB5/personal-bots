import {
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  EnvironmentAuthorizationError,
  ProviderInstanceId,
  ProviderSetupError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  resetCreditFailureText,
  resetCreditOffer,
  RESET_CREDIT_NO_SCOPE_TEXT,
  RESET_CREDIT_PAIR_AGAIN_TEXT,
  RESET_CREDIT_UNKNOWN_OUTCOME_TEXT,
} from "./usagePresentation.ts";

const setupError = (detail: string) =>
  new ProviderSetupError({
    instanceId: ProviderInstanceId.make("claudeAgent"),
    operation: "consume-reset-credit",
    detail,
  });

const UNKNOWN = "The reset outcome is unknown. Refresh usage before trying again.";

describe("resetCreditFailureText", () => {
  it("names the scope a paired device is missing instead of a vague failure", () => {
    expect(
      resetCreditFailureText(
        Cause.fail(
          new EnvironmentAuthorizationError({
            message: "This connection requires providers:manage.",
            requiredScope: AuthOrchestrationOperateScope,
            requiredPermission: AuthProvidersManageScope,
          }),
        ),
      ),
    ).toBe(RESET_CREDIT_NO_SCOPE_TEXT);
    expect(RESET_CREDIT_NO_SCOPE_TEXT).toBe(
      "This device is not allowed to redeem resets. Pair it again to allow it. No credit was used.",
    );
  });

  it("says no credit was used when the server refused before the provider call", () => {
    expect(
      resetCreditFailureText(
        Cause.fail(
          new EnvironmentAuthorizationError({
            message: "This connection requires settings:write.",
            requiredScope: AuthOrchestrationOperateScope,
            requiredPermission: "settings:write",
          }),
        ),
      ),
    ).toBe("Could not use the reset credit. No credit was used.");
  });

  it("shows every known server outcome as it arrived", () => {
    for (const detail of [
      "Claude returned a malformed reset credit.",
      "Claude could not read its login.",
      "Claude could not read its account.",
      "Sign in to Claude again to redeem resets.",
      "Claude is rate limiting resets. Try again soon.",
      "Claude resets are cooling down. Try again later.",
      "The reset was applied, but Claude could not confirm the new limits. Refresh to check.",
      "The reset was applied, but Codex could not confirm the new limits. Refresh to check.",
    ]) {
      expect(resetCreditFailureText(Cause.fail(setupError(detail)))).toBe(detail);
    }
  });

  it("does not claim no credit when the provider call outcome is unknown", () => {
    for (const detail of [
      "Claude could not confirm the reset. If you are still limited in a moment, try again.",
      "Claude could not redeem the reset.",
      "Codex could not redeem the reset credit.",
    ]) {
      expect(resetCreditFailureText(Cause.fail(setupError(detail)))).toBe(
        RESET_CREDIT_UNKNOWN_OUTCOME_TEXT,
      );
    }
    expect(RESET_CREDIT_UNKNOWN_OUTCOME_TEXT).toBe(UNKNOWN);
  });

  it("uses the unknown-outcome line when the failure carries no useful message", () => {
    expect(resetCreditFailureText(Cause.interrupt())).toBe(UNKNOWN);
    expect(resetCreditFailureText(Cause.fail(setupError("  ")))).toBe(UNKNOWN);
    expect(resetCreditFailureText(Cause.die("not an error"))).toBe(UNKNOWN);
  });

  it("never repeats a transport message, defect or unknown server sentence", () => {
    for (const cause of [
      Cause.fail(new Error("RpcClientError: socket closed")),
      Cause.fail(new Error("Request timed out after 30000ms")),
      Cause.fail(new Error("connect ECONNREFUSED 127.0.0.1:3773")),
      Cause.fail(new Error("Provider driver error: SQLITE_BUSY at /home/x/db")),
      Cause.die(new Error("TypeError: undefined is not a function")),
      Cause.fail(new Error("Empty cause")),
      Cause.fail(setupError("401 Incorrect API key provided")),
      Cause.fail({ message: "plain object" }),
      Cause.die(undefined),
    ]) {
      const text = resetCreditFailureText(cause);
      expect(text).toBe(UNKNOWN);
      for (const leak of ["127.0.0.1", "/home", "ECONNREFUSED", "SQLITE_BUSY", "socket", "401"]) {
        expect(text).not.toContain(leak);
      }
    }
  });

  it("offers the phone's pairing line as the pre-flight copy", () => {
    expect(RESET_CREDIT_PAIR_AGAIN_TEXT).toBe("Pair this device again to redeem resets.");
  });
});

describe("resetCreditOffer", () => {
  it("offers Redeem only to a device with providers:manage", () => {
    expect(resetCreditOffer(1, true)).toEqual({ _tag: "Redeem" });
    expect(resetCreditOffer(3, true)).toEqual({ _tag: "Redeem" });
  });

  it("offers the pairing line instead of a button without providers:manage", () => {
    expect(resetCreditOffer(1, false)).toEqual({
      _tag: "PairAgain",
      notice: "Pair this device again to redeem resets.",
    });
  });

  it("offers nothing when no credit is banked", () => {
    expect(resetCreditOffer(0, true)).toEqual({ _tag: "Hidden" });
    expect(resetCreditOffer(0, false)).toEqual({ _tag: "Hidden" });
  });
});
