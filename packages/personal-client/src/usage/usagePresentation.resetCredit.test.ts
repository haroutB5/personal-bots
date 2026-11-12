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
  RESET_CREDIT_NO_SCOPE_TEXT,
  RESET_CREDIT_PAIR_AGAIN_TEXT,
  RESET_CREDIT_UNCONFIRMED_TEXT,
} from "./usagePresentation.ts";

const setupError = (detail: string) =>
  new ProviderSetupError({
    instanceId: ProviderInstanceId.make("claudeAgent"),
    operation: "consume-reset-credit",
    detail,
  });

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

  it("keeps a specific server line for a known cause", () => {
    expect(
      resetCreditFailureText(
        Cause.fail(setupError("Claude is rate limiting resets. Try again soon.")),
      ),
    ).toBe("Claude is rate limiting resets. Try again soon.");
  });

  it("does not claim no credit when the provider call outcome is unknown", () => {
    for (const detail of [
      "Claude could not confirm the reset. If you are still limited in a moment, try again.",
      "Claude could not redeem the reset.",
      "Codex could not redeem the reset credit.",
    ]) {
      expect(resetCreditFailureText(Cause.fail(setupError(detail)))).toBe(
        RESET_CREDIT_UNCONFIRMED_TEXT,
      );
    }
    expect(RESET_CREDIT_UNCONFIRMED_TEXT).toBe(
      "The reset may not have gone through. Check your limit before trying again.",
    );
  });

  it("uses the unknown-outcome line when the failure carries no useful message", () => {
    expect(resetCreditFailureText(Cause.interrupt())).toBe(RESET_CREDIT_UNCONFIRMED_TEXT);
    expect(resetCreditFailureText(Cause.fail(setupError("  ")))).toBe(
      RESET_CREDIT_UNCONFIRMED_TEXT,
    );
    expect(resetCreditFailureText(Cause.die("not an error"))).toBe(RESET_CREDIT_UNCONFIRMED_TEXT);
  });

  it("keeps a defect's message", () => {
    expect(resetCreditFailureText(Cause.die(new Error("socket closed")))).toBe("socket closed");
  });

  it("offers the phone's pairing line as the pre-flight copy", () => {
    expect(RESET_CREDIT_PAIR_AGAIN_TEXT).toBe("Pair this device again to redeem resets.");
  });
});
