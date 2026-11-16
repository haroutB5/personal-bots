import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { describe, expect, it, vi } from "vite-plus/test";

import { startReconnectCheck } from "../reconnectCheck";
import { subscribeConnectedPhase } from "./connectionSubscription";

type Phase = "connecting" | "connected" | "offline";
type State = { readonly phase: Phase };

// oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- @effect/vitest is not a dependency of this package, and the listener under test is plain callbacks over a ref.
const makeRef = () => Effect.runSync(SubscriptionRef.make<State>({ phase: "connecting" }));
const setPhase = (ref: SubscriptionRef.SubscriptionRef<State>, phase: Phase) =>
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- same reason as makeRef.
  Effect.runSync(SubscriptionRef.set(ref, { phase }));
// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- the listener runs on a stream fiber; a check that nothing arrives has no milestone to await, so it gets one short turn of the event loop.
const tick = () => new Promise((done) => setTimeout(done, 20));

const noUpdates = { subscribe: () => () => undefined };

describe("the connected listener", () => {
  it("reports the current state first, then each change", async () => {
    const ref = makeRef();
    const seen: boolean[] = [];
    const stop = subscribeConnectedPhase(ref, (connected) => seen.push(connected));

    setPhase(ref, "connected");
    setPhase(ref, "offline");
    await tick();
    stop();

    expect(seen).toEqual([false, true, false]);
  });

  it("stops at unsubscribe, even for a change made in the same tick", async () => {
    const ref = makeRef();
    const seen: boolean[] = [];
    const stop = subscribeConnectedPhase(ref, (connected) => seen.push(connected));
    await tick();

    stop();
    setPhase(ref, "connected");
    setPhase(ref, "offline");
    setPhase(ref, "connected");
    await tick();

    expect(seen).toEqual([false]);
  });

  it("leaves no live listener after 500 subscribe and unsubscribe cycles", async () => {
    const ref = makeRef();
    let calls = 0;
    for (let index = 0; index < 500; index += 1) {
      subscribeConnectedPhase(ref, () => {
        calls += 1;
      })();
    }
    await tick();
    const before = calls;

    setPhase(ref, "connected");
    setPhase(ref, "offline");
    await tick();

    expect(calls - before).toBe(0);
  });
});

describe("the reconnect check on a real connection state", () => {
  it("never fires after it was stopped, even for a reconnect right after", async () => {
    const ref = makeRef();
    const check = vi.fn();
    const clock = { at: 1_000_000 };
    const stop = startReconnectCheck({
      connection: { subscribe: (listener) => subscribeConnectedPhase(ref, listener) },
      updates: noUpdates,
      check,
      isOn: () => true,
      now: () => clock.at,
    });
    await tick();
    clock.at += 10 * 60_000;

    stop();
    setPhase(ref, "connected");
    await tick();

    expect(check).not.toHaveBeenCalled();
  });

  it("treats a socket that is already up at subscribe time as the first connect, a moment after the launch check", async () => {
    const ref = makeRef();
    setPhase(ref, "connected");
    const check = vi.fn();
    const clock = { at: 1_000_000 };

    startReconnectCheck({
      connection: { subscribe: (listener) => subscribeConnectedPhase(ref, listener) },
      updates: noUpdates,
      check,
      isOn: () => true,
      now: () => clock.at,
    });
    await tick();

    expect(check).not.toHaveBeenCalled();
  });
});
