import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "@effect/vitest";

import { runViewerFrames, untilAnyFlowTookFrame, ViewerFlow } from "./viewerFlow.ts";

const frame = (tag: number) => new Uint8Array([tag]);

/** A flow on a clock the test moves by hand, with a settable socket backlog. */
const makeFlow = (options: ConstructorParameters<typeof ViewerFlow>[0] = {}) => {
  const clock = { now: 1_000 };
  const link = { backlog: 0 };
  const flow = new ViewerFlow({ now: () => clock.now, ...options });
  flow.setBacklogProbe(() => link.backlog);
  return { flow, clock, link };
};

describe("ViewerFlow", () => {
  it("sends the first frame at once and only the newest of a burst", () => {
    const { flow, clock } = makeFlow();
    flow.offerFrame(frame(1));
    expect(flow.poll()).toEqual({ _tag: "Send", frame: frame(1) });
    // Three more arrive inside the same frame slot: two are overwritten.
    flow.offerFrame(frame(2));
    flow.offerFrame(frame(3));
    flow.offerFrame(frame(4));
    expect(flow.replaced).toBe(2);
    expect(flow.poll()).toMatchObject({ _tag: "Wait" });
    clock.now += 50;
    expect(flow.poll()).toEqual({ _tag: "Send", frame: frame(4) });
    expect(flow.poll()).toEqual({ _tag: "Idle" });
  });

  it("caps the frame rate however fast frames arrive", () => {
    const { flow, clock } = makeFlow({ maxFps: 20 });
    let sent = 0;
    // Chrome painting a frame every 8 ms (well over 60 fps) for 3 seconds.
    for (let tick = 0; tick < 375; tick += 1) {
      flow.offerFrame(frame(tick % 255));
      if (flow.poll()._tag === "Send") sent += 1;
      clock.now += 8;
    }
    expect(sent).toBeLessThanOrEqual(61);
    expect(sent).toBeGreaterThanOrEqual(45);
  });

  it("holds a slow socket to one frame in the socket and one pending, newest wins", () => {
    const { flow, clock, link } = makeFlow();
    flow.offerFrame(frame(1));
    expect(flow.poll()._tag).toBe("Send");
    // The link stalls: the socket still holds the first frame.
    link.backlog = 90_000;
    let sentWhileStalled = 0;
    for (let tick = 0; tick < 100; tick += 1) {
      clock.now += 16;
      flow.offerFrame(frame(10 + (tick % 100)));
      if (flow.poll()._tag === "Send") sentWhileStalled += 1;
      expect(flow.hasPending).toBe(true);
    }
    expect(sentWhileStalled).toBe(0);
    // The link recovers: exactly the newest frame goes, nothing older.
    link.backlog = 0;
    expect(flow.poll()).toEqual({ _tag: "Send", frame: frame(10 + 99) });
    expect(flow.poll()).toEqual({ _tag: "Idle" });
    expect(flow.replaced).toBe(99);
  });

  it("waits for the socket to drain before the next frame, whatever the rate cap", () => {
    const { flow, clock, link } = makeFlow();
    flow.offerFrame(frame(1));
    flow.poll();
    clock.now += 500;
    link.backlog = 20_000;
    flow.offerFrame(frame(2));
    expect(flow.poll()).toEqual({ _tag: "Wait", ms: 10 });
    link.backlog = 4_000;
    expect(flow.poll()).toEqual({ _tag: "Send", frame: frame(2) });
  });

  it("keeps at most two frames unacknowledged once the phone acknowledges", () => {
    const { flow, clock } = makeFlow();
    flow.offerFrame(frame(1));
    expect(flow.poll()._tag).toBe("Send");
    flow.acknowledge();
    expect(flow.inFlight).toBe(0);
    // Two frames out, no acknowledgement coming back yet.
    for (const tag of [2, 3]) {
      clock.now += 50;
      flow.offerFrame(frame(tag));
      expect(flow.poll()._tag).toBe("Send");
    }
    expect(flow.inFlight).toBe(2);
    clock.now += 50;
    flow.offerFrame(frame(4));
    expect(flow.poll()).toMatchObject({ _tag: "Wait" });
    flow.acknowledge();
    expect(flow.poll()).toEqual({ _tag: "Send", frame: frame(4) });
  });

  it("does not wait for acknowledgements a client never sends", () => {
    const { flow, clock } = makeFlow();
    for (let tag = 0; tag < 10; tag += 1) {
      flow.offerFrame(frame(tag));
      expect(flow.poll()._tag).toBe("Send");
      clock.now += 50;
    }
    expect(flow.inFlight).toBe(0);
  });

  it("presumes lost frames after the acknowledgement silence and carries on", () => {
    const { flow, clock } = makeFlow({ ackStallMs: 2_000 });
    flow.offerFrame(frame(1));
    flow.poll();
    flow.acknowledge();
    for (const tag of [2, 3]) {
      clock.now += 50;
      flow.offerFrame(frame(tag));
      flow.poll();
    }
    clock.now += 50;
    flow.offerFrame(frame(4));
    const blocked = flow.poll();
    expect(blocked).toMatchObject({ _tag: "Wait" });
    clock.now += 1_900;
    expect(flow.poll()).toMatchObject({ _tag: "Wait" });
    clock.now += 100;
    expect(flow.poll()).toEqual({ _tag: "Send", frame: frame(4) });
  });

  it("drops the unsent frame on request", () => {
    const { flow } = makeFlow();
    flow.offerFrame(frame(1));
    flow.dropPending();
    expect(flow.hasPending).toBe(false);
    expect(flow.poll()).toEqual({ _tag: "Idle" });
  });

  // The writer resumes inside the notification and subscribes again at once.
  it("tells a listener that re-subscribes during a change only once for it", () => {
    const { flow } = makeFlow();
    let calls = 0;
    const listen = () => {
      const leave = flow.subscribe(() => {
        calls += 1;
        leave();
        if (calls < 50) listen();
      });
    };
    listen();
    flow.offerFrame(frame(1));
    expect(calls).toBe(1);
  });

  it("tells subscribers about every change until they leave", () => {
    const { flow } = makeFlow();
    let changes = 0;
    const leave = flow.subscribe(() => {
      changes += 1;
    });
    flow.offerFrame(frame(1));
    flow.poll();
    flow.acknowledge();
    expect(changes).toBe(3);
    leave();
    flow.offerFrame(frame(2));
    expect(changes).toBe(3);
  });
});

describe("runViewerFrames", () => {
  it.live("sends frames as they arrive and as the link frees up, then stops on interrupt", () =>
    Effect.gen(function* () {
      const link = { backlog: 0 };
      const flow = new ViewerFlow({ maxFps: 200 });
      flow.setBacklogProbe(() => link.backlog);
      const written: number[] = [];
      const fiber = yield* Effect.forkChild(
        runViewerFrames(flow, (bytes) =>
          Effect.sync(() => {
            written.push(bytes[0]!);
          }),
        ),
      );
      flow.offerFrame(frame(1));
      yield* Effect.sleep(30);
      expect(written).toEqual([1]);

      link.backlog = 100_000;
      flow.offerFrame(frame(2));
      flow.offerFrame(frame(3));
      yield* Effect.sleep(60);
      expect(written).toEqual([1]);
      link.backlog = 0;
      yield* Effect.sleep(60);
      expect(written).toEqual([1, 3]);

      yield* Fiber.interrupt(fiber);
      flow.offerFrame(frame(4));
      yield* Effect.sleep(30);
      expect(written).toEqual([1, 3]);
    }),
  );

  it.live("releases the Chrome ack once a phone took the frame, or after the cap", () =>
    Effect.gen(function* () {
      const link = { backlog: 0 };
      const flow = new ViewerFlow({ maxFps: 1_000 });
      flow.setBacklogProbe(() => link.backlog);
      flow.offerFrame(frame(1));
      flow.poll();
      link.backlog = 100_000;
      flow.offerFrame(frame(2));

      let released = false;
      const held = yield* Effect.forkChild(
        Effect.andThen(
          untilAnyFlowTookFrame([flow], 150),
          Effect.sync(() => {
            released = true;
          }),
        ),
      );
      yield* Effect.sleep(30);
      expect(released).toBe(false);
      link.backlog = 0;
      expect(flow.poll()._tag).toBe("Send");
      yield* Fiber.join(held);
      expect(released).toBe(true);

      // Stuck for good: the cap lets Chrome carry on.
      link.backlog = 100_000;
      flow.offerFrame(frame(3));
      const startedAt = performance.now();
      yield* untilAnyFlowTookFrame([flow], 80);
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(70);
    }),
  );
});
