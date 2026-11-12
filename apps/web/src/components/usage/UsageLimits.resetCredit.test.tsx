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

import { ResetCredits, useResetCredit } from "./UsageLimits";

const state = vi.hoisted(() => ({ consume: vi.fn(), allowed: true }));

// Upstream gates consume behind AuthProvidersManageScope; the owner holds it.
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => state.allowed,
  readEnvironmentScope: () => state.allowed,
}));
// Never the real RPC: a redeem spends a real banked reset.
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => state.consume,
}));
// The dialog is not what these tests prove; a closed one renders nothing.
vi.mock("~/components/ui/alert-dialog", async () => {
  const { createElement, Fragment } = await import("react");
  const passthrough = ({ children }: { readonly children?: unknown }) =>
    createElement(Fragment, null, children as never);
  return {
    AlertDialog: ({ open, children }: { readonly open?: boolean; readonly children?: unknown }) =>
      open ? createElement(Fragment, null, children as never) : null,
    AlertDialogClose: passthrough,
    AlertDialogDescription: passthrough,
    AlertDialogFooter: passthrough,
    AlertDialogHeader: passthrough,
    AlertDialogPopup: passthrough,
    AlertDialogTitle: passthrough,
  };
});

const ENV = "env-1" as EnvironmentId;
const INPUT = { instanceId: ProviderInstanceId.make("claudeAgent") };
const NOW = Date.parse("2026-09-13T12:00:00Z");
const UNKNOWN = "The reset outcome is unknown. Refresh usage before trying again.";

function setupError(detail: string) {
  return new ProviderSetupError({
    instanceId: INPUT.instanceId,
    operation: "consume-reset-credit",
    detail,
  });
}

describe("resetCreditFailureText", () => {
  it("shows a known server outcome as it arrived", () => {
    expect(
      resetCreditFailureText(
        Cause.fail(setupError("Claude is rate limiting resets. Try again soon.")),
      ),
    ).toBe("Claude is rate limiting resets. Try again soon.");
    expect(
      resetCreditFailureText(
        Cause.fail(new UsageLimitSourceError({ detail: "Claude could not read its login." })),
      ),
    ).toBe("Claude could not read its login.");
  });

  it("replaces a transport, defect or unknown message with the unknown outcome", () => {
    expect(resetCreditFailureText(Cause.die(new Error("socket closed")))).toBe(UNKNOWN);
    expect(resetCreditFailureText(Cause.fail(setupError("This provider is disabled.")))).toBe(
      UNKNOWN,
    );
    expect(
      resetCreditFailureText(Cause.fail(new UsageLimitSourceError({ detail: "Hub timed out." }))),
    ).toBe(UNKNOWN);
  });

  it("says the outcome is unknown when there is no message", () => {
    expect(resetCreditFailureText(Cause.interrupt())).toBe(UNKNOWN);
    expect(resetCreditFailureText(Cause.fail(setupError("  ")))).toBe(UNKNOWN);
    expect(resetCreditFailureText(Cause.die("not an error"))).toBe(UNKNOWN);
  });

  it("never repeats a host, path, error code or defect", () => {
    for (const cause of [
      Cause.fail(new Error("connect ECONNREFUSED 127.0.0.1:3773")),
      Cause.fail(new Error("SQLITE_BUSY at /home/x/db")),
      Cause.fail(new Error("Empty cause")),
      Cause.die(new Error("TypeError: undefined is not a function")),
      Cause.die(undefined),
      Cause.fail({ message: "plain object" }),
    ]) {
      const text = resetCreditFailureText(cause);
      expect(text).toBe(UNKNOWN);
      for (const leak of ["127.0.0.1", "/home", "ECONNREFUSED", "SQLITE_BUSY", "socket", "Empty"]) {
        expect(text).not.toContain(leak);
      }
    }
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
    state.allowed = true;
    await act(async () => {
      renderer = create(<Probe />);
    });
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    probe.hook = undefined;
  });

  it("puts a known server message in status on a failed redeem", async () => {
    state.consume.mockResolvedValue(
      AsyncResult.failure(
        Cause.fail(setupError("Claude is rate limiting resets. Try again soon.")),
      ),
    );
    await act(async () => probe.hook!.redeem());
    expect(state.consume).toHaveBeenCalledWith({ environmentId: ENV, input: INPUT });
    expect(probe.hook!.status).toBe("Claude is rate limiting resets. Try again soon.");
    expect(probe.hook!.busy).toBe(false);
  });

  it("does not put a transport error in status", async () => {
    state.consume.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("connect ECONNREFUSED 127.0.0.1:3773"))),
    );
    await act(async () => probe.hook!.redeem());
    expect(probe.hook!.status).toBe(UNKNOWN);
  });

  it("shows the pairing line instead of trying without providers:manage", async () => {
    state.allowed = false;
    await act(async () => probe.hook!.redeem());
    expect(state.consume).not.toHaveBeenCalled();
    expect(probe.hook!.status).toBe("Pair this device again to redeem resets.");
  });

  it("says the outcome is unknown when the failure has no message", async () => {
    state.consume.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));
    await act(async () => probe.hook!.redeem());
    expect(probe.hook!.status).toBe(UNKNOWN);
  });

  it("still reports a successful outcome", async () => {
    state.consume.mockResolvedValue(AsyncResult.success({ outcome: "reset" }));
    await act(async () => probe.hook!.redeem());
    expect(probe.hook!.status).toBe("Reset applied. Your windows have cleared.");
  });
});

// The Limits tab's own card; the Bots sheet has PersonalResetCredits.
describe("ResetCredits", () => {
  let renderer: ReactTestRenderer | undefined;
  const credits = { availableCount: 1, nextExpiresAt: "2026-09-20T12:00:00Z" };

  async function mount() {
    await act(async () => {
      renderer = create(
        <ResetCredits environmentId={ENV} input={INPUT} credits={credits} now={NOW} />,
      );
    });
  }

  function useResetButtons() {
    return renderer!.root.findAll(
      (node) => node.type === "button" && node.props.children === "Use reset",
    );
  }

  beforeEach(() => {
    state.consume = vi.fn();
    state.allowed = true;
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
  });

  it("hides Use reset and shows the pairing line without providers:manage", async () => {
    state.allowed = false;
    await mount();
    expect(useResetButtons()).toHaveLength(0);
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "Pair this device again to redeem resets.",
    );
  });

  it("shows Use reset and no pairing line with providers:manage", async () => {
    await mount();
    expect(useResetButtons()).toHaveLength(1);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain(
      "Pair this device again to redeem resets.",
    );
  });
});
