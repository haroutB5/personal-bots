import {
  type EnvironmentId,
  ProviderInstanceId,
  ProviderSetupError,
  UsageLimitSourceError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { act } from "../../../test/rendererAct";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resetCreditFailureText } from "~/features/personal/usagePresentation";

import { useResetCredit } from "./UsageLimits";

const state = vi.hoisted(() => ({ consume: vi.fn() }));

// Upstream gates consume behind AuthProvidersManageScope; the owner holds it.
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
// Never the real RPC: a redeem spends a real banked reset.
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => state.consume,
}));

const ENV = "env-1" as EnvironmentId;
const INPUT = { instanceId: ProviderInstanceId.make("claudeAgent") };
const UNCONFIRMED = "The reset may not have gone through. Check your limit before trying again.";

function setupError(detail: string) {
  return new ProviderSetupError({
    instanceId: INPUT.instanceId,
    operation: "consume-reset-credit",
    detail,
  });
}

describe("resetCreditFailureText", () => {
  it("reads the server's typed error out of the Cause", () => {
    expect(resetCreditFailureText(Cause.fail(setupError("This provider is disabled.")))).toBe(
      "This provider is disabled.",
    );
    expect(
      resetCreditFailureText(Cause.fail(new UsageLimitSourceError({ detail: "Hub timed out." }))),
    ).toBe("Hub timed out.");
  });

  it("shows a defect's message", () => {
    expect(resetCreditFailureText(Cause.die(new Error("socket closed")))).toBe("socket closed");
  });

  it("says the outcome is unknown when there is no message", () => {
    expect(resetCreditFailureText(Cause.interrupt())).toBe(UNCONFIRMED);
    expect(resetCreditFailureText(Cause.fail(setupError("  ")))).toBe(UNCONFIRMED);
    expect(resetCreditFailureText(Cause.die("not an error"))).toBe(UNCONFIRMED);
  });
});

// The Limits tab (developer view) and the Bots usage sheet share this hook.
describe("useResetCredit", () => {
  const probe: { hook?: ReturnType<typeof useResetCredit> | undefined } = {};
  let renderer: ReactTestRenderer | undefined;

  function Probe() {
    const next = useResetCredit(ENV, INPUT);
    useEffect(() => {
      probe.hook = next;
    });
    return null;
  }

  beforeEach(async () => {
    state.consume = vi.fn();
    await act(async () => {
      renderer = create(<Probe />);
    });
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    probe.hook = undefined;
  });

  it("puts the server's message in status on a failed redeem", async () => {
    state.consume.mockResolvedValue(
      AsyncResult.failure(Cause.fail(setupError("401 Incorrect API key provided"))),
    );
    await act(async () => probe.hook!.redeem());
    expect(state.consume).toHaveBeenCalledWith({ environmentId: ENV, input: INPUT });
    expect(probe.hook!.status).toBe("401 Incorrect API key provided");
    expect(probe.hook!.busy).toBe(false);
  });

  it("says the outcome is unknown when the failure has no message", async () => {
    state.consume.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));
    await act(async () => probe.hook!.redeem());
    expect(probe.hook!.status).toBe(UNCONFIRMED);
  });

  it("still reports a successful outcome", async () => {
    state.consume.mockResolvedValue(AsyncResult.success({ outcome: "reset" }));
    await act(async () => probe.hook!.redeem());
    expect(probe.hook!.status).toBe("Reset applied. Your windows have cleared.");
  });
});
