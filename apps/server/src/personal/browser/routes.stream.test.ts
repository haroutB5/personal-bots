// @effect-diagnostics globalTimers:off - the throttled relay is a plain Node TCP fixture
/**
 * The live viewport socket on a slow link, end to end: the real stream route on
 * a real HTTP server, a throttled relay in front of it (what cloudflared and the
 * phone's connection are), and a WebSocket client that times every frame.
 *
 * Before flow control the route wrote every frame at once, so a link slower than
 * Chrome's frame rate made the delay grow without bound. Now it stays bounded.
 */
import * as NodeNet from "node:net";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import { PersonalBrowser, type ViewerHandle } from "./PersonalBrowser.ts";
import { personalBrowserStreamRouteLayer } from "./routes.ts";
import { untilAnyFlowTookFrame, ViewerFlow, type ViewerFlowOptions } from "./viewerFlow.ts";

const FRAME_BYTES = 60_000;
const CHROME_FRAME_MS = 16;

interface Scenario {
  /** Real flow control, or the old behaviour: every frame written at once. */
  readonly paced: boolean;
  /** Whether the client sends frame acknowledgements (an older client does not). */
  readonly clientAcks: boolean;
  readonly linkBytesPerSecond: number;
  /** What the relay holds before it stops reading from the server. */
  readonly relayBufferBytes: number;
  readonly durationMs: number;
}

interface Stats {
  readonly produced: number;
  readonly received: number;
  readonly latenciesMs: ReadonlyArray<number>;
  readonly maxRelayQueueBytes: number;
  readonly control: ReadonlyArray<string>;
}

const percentile = (values: ReadonlyArray<number>, p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

/** A TCP relay that passes the server's bytes to the client at a fixed rate. */
const startRelay = (targetPort: number, bytesPerSecond: number, bufferBytes: number) =>
  new Promise<{ port: number; queued: () => number; close: () => void }>((resolve) => {
    const sockets = new Set<NodeNet.Socket>();
    let queuedBytes = 0;
    const timers = new Set<ReturnType<typeof setInterval>>();
    const server = NodeNet.createServer((client) => {
      const upstream = NodeNet.connect(targetPort, "127.0.0.1");
      sockets.add(client);
      sockets.add(upstream);
      const queue: Buffer[] = [];
      client.pipe(upstream);
      upstream.on("data", (chunk: Buffer) => {
        queue.push(chunk);
        queuedBytes += chunk.length;
        if (queuedBytes > bufferBytes) upstream.pause();
      });
      // Timers on Windows tick about every 15 ms, not 10, so meter by elapsed time.
      let lastTickAt = performance.now();
      let credit = 0;
      const tick = setInterval(() => {
        const now = performance.now();
        credit = Math.min(credit + ((now - lastTickAt) / 1_000) * bytesPerSecond, bytesPerSecond);
        lastTickAt = now;
        let budget = Math.floor(credit);
        while (budget > 0 && queue.length > 0) {
          const head = queue[0]!;
          const part = head.subarray(0, budget);
          client.write(part);
          budget -= part.length;
          credit -= part.length;
          queuedBytes -= part.length;
          if (part.length === head.length) queue.shift();
          else queue[0] = head.subarray(part.length);
        }
        if (queuedBytes <= bufferBytes) upstream.resume();
      }, 10);
      timers.add(tick);
      const end = () => {
        clearInterval(tick);
        client.destroy();
        upstream.destroy();
      };
      client.on("close", end);
      upstream.on("close", end);
      client.on("error", () => {});
      upstream.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as NodeNet.AddressInfo).port,
        queued: () => queuedBytes,
        close: () => {
          for (const timer of timers) clearInterval(timer);
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });

/** The real stream route on a real HTTP server; returns its port. `handle` takes the viewer's inputs. */
const serveViewerRoute = (viewer: ViewerHandle, handle: (raw: string) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const authLayer = Layer.succeed(EnvironmentAuth, {
      authenticateWebSocketUpgrade: () =>
        Effect.succeed({
          sessionId: AuthSessionId.make("session-1"),
          subject: "test",
          method: "bearer-access-token",
          scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        }),
    } as unknown as EnvironmentAuth["Service"]);
    const browserLayer = Layer.succeed(PersonalBrowser, {
      attachViewer: () => Effect.succeed(viewer),
      handleViewerMessage: (_viewer: ViewerHandle, raw: string) => handle(raw),
    } as unknown as PersonalBrowser["Service"]);
    yield* HttpRouter.serve(
      personalBrowserStreamRouteLayer.pipe(
        Layer.provideMerge(authLayer),
        Layer.provideMerge(browserLayer),
        Layer.provideMerge(Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer)),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(Layer.build, Effect.provide(Layer.mergeAll(authLayer, browserLayer)));
    const server = yield* HttpServer.HttpServer;
    const address = server.address;
    if (address._tag === "UnixPathAddress") throw new Error("expected a TCP server");
    return address.port;
  });

const runScenario = (scenario: Scenario) =>
  Effect.gen(function* () {
    const flowOptions: ViewerFlowOptions = scenario.paced
      ? {}
      : { maxFps: 1_000_000, backlogLimitBytes: Number.POSITIVE_INFINITY };
    const flow = new ViewerFlow(flowOptions);
    const outbox = yield* Queue.unbounded<string>();
    const viewer: ViewerHandle = {
      id: 1,
      sessionId: "session-1",
      canOperate: true,
      outbox,
      flow,
      telemetry: null,
    };

    const port = yield* serveViewerRoute(viewer, (raw) =>
      Effect.sync(() => {
        if (raw.includes("FrameAck")) flow.acknowledge();
      }),
    );
    const relay = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startRelay(port, scenario.linkBytesPerSecond, scenario.relayBufferBytes),
      ),
      (started) => Effect.sync(() => started.close()),
    );
    const latenciesMs: number[] = [];
    const control: string[] = [];
    let acknowledge = false;
    yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<WebSocket>((resolve, reject) => {
            const socket = new WebSocket(
              `ws://127.0.0.1:${relay.port}/api/personal/browser/stream`,
            );
            socket.binaryType = "arraybuffer";
            socket.addEventListener("message", (event: MessageEvent) => {
              if (typeof event.data === "string") {
                control.push(event.data);
                if (scenario.clientAcks && event.data.includes("FrameAcks")) acknowledge = true;
                return;
              }
              if (acknowledge) socket.send(JSON.stringify({ _tag: "FrameAck" }));
              const sentAt = new DataView(event.data as ArrayBuffer).getFloat64(0);
              latenciesMs.push(performance.now() - sentAt);
            });
            socket.addEventListener("open", () => resolve(socket), { once: true });
            socket.addEventListener("error", () => reject(new Error("socket error")), {
              once: true,
            });
          }),
      ),
      (socket) => Effect.sync(() => socket.close()),
    );

    let maxRelayQueueBytes = 0;
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.andThen(
          Effect.sleep(20),
          Effect.sync(() => {
            maxRelayQueueBytes = Math.max(maxRelayQueueBytes, relay.queued());
          }),
        ),
      ),
    );

    // Chrome: renders a frame every ~16 ms, and with flow control only after its
    // previous frame was handed to a phone (the ack the driver holds back).
    let produced = 0;
    const startedAt = performance.now();
    while (performance.now() - startedAt < scenario.durationMs) {
      yield* Effect.sleep(CHROME_FRAME_MS);
      const frame = new Uint8Array(FRAME_BYTES);
      new DataView(frame.buffer).setFloat64(0, performance.now());
      flow.offerFrame(frame);
      produced += 1;
      if (scenario.paced) yield* untilAnyFlowTookFrame([flow], 500);
    }
    // Let frames still on the way land before counting.
    yield* Effect.sleep(400);
    const stats: Stats = {
      produced,
      received: latenciesMs.length,
      latenciesMs,
      maxRelayQueueBytes,
      control,
    };
    return stats;
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));

const SLOW_LINK = {
  // About 10 frames per second of 60 kB: Chrome's ~60 fps is six times too fast.
  linkBytesPerSecond: 600_000,
  relayBufferBytes: 256_000,
  durationMs: 3_000,
} as const;

describe("live viewport socket on a slow link", () => {
  it.live("keeps frame delay bounded for a phone that acknowledges frames", () =>
    Effect.gen(function* () {
      const stats = yield* runScenario({ ...SLOW_LINK, paced: true, clientAcks: true });
      yield* Effect.logInfo(
        `[stream-lag] paced+acks produced=${stats.produced} received=${stats.received} ` +
          `p50=${percentile(stats.latenciesMs, 0.5).toFixed(0)}ms ` +
          `p95=${percentile(stats.latenciesMs, 0.95).toFixed(0)}ms ` +
          `max=${Math.max(...stats.latenciesMs).toFixed(0)}ms relayQueueMax=${stats.maxRelayQueueBytes}`,
      );
      expect(stats.received).toBeGreaterThan(15);
      expect(percentile(stats.latenciesMs, 0.95)).toBeLessThan(900);
      // The first message on the socket asks the client to acknowledge frames.
      expect(stats.control[0]).toContain("FrameAcks");
      // Never more than a couple of frames sitting in the relay.
      expect(stats.maxRelayQueueBytes).toBeLessThan(4 * FRAME_BYTES);
    }),
  );

  // Without acknowledgements only the socket's own backlog is visible, and on one
  // machine the kernel buffers absorb a megabyte before it shows. So this client is
  // not bounded as tightly (the numbers print above); what must still hold is that
  // Chrome is slowed down and nothing breaks. Such clients are only a cached app
  // from before this release, which the next load replaces.
  it.live("still slows Chrome for an older client that sends no acknowledgements", () =>
    Effect.gen(function* () {
      const stats = yield* runScenario({ ...SLOW_LINK, paced: true, clientAcks: false });
      yield* Effect.logInfo(
        `[stream-lag] paced+noacks produced=${stats.produced} received=${stats.received} ` +
          `p50=${percentile(stats.latenciesMs, 0.5).toFixed(0)}ms ` +
          `p95=${percentile(stats.latenciesMs, 0.95).toFixed(0)}ms ` +
          `max=${Math.max(...stats.latenciesMs).toFixed(0)}ms relayQueueMax=${stats.maxRelayQueueBytes}`,
      );
      expect(stats.received).toBeGreaterThan(15);
      expect(stats.produced).toBeLessThan(100);
    }),
  );

  it.live("without flow control the delay grows for as long as the link is slow", () =>
    Effect.gen(function* () {
      const stats = yield* runScenario({ ...SLOW_LINK, paced: false, clientAcks: false });
      yield* Effect.logInfo(
        `[stream-lag] unpaced produced=${stats.produced} received=${stats.received} ` +
          `p50=${percentile(stats.latenciesMs, 0.5).toFixed(0)}ms ` +
          `p95=${percentile(stats.latenciesMs, 0.95).toFixed(0)}ms ` +
          `max=${Math.max(...stats.latenciesMs).toFixed(0)}ms relayQueueMax=${stats.maxRelayQueueBytes}`,
      );
      // The old path: late frames, and a delay that only keeps climbing.
      expect(Math.max(...stats.latenciesMs)).toBeGreaterThan(1_500);
    }),
  );
});

// A scroll still being dispatched to Chrome must not hold up the acknowledgement that
// paces the next frame: in 1.60.31 and 1.60.32 both went through one loop, in order.
describe("frame acknowledgements while an input is being handled", () => {
  const WHEEL = '{"_tag":"Wheel","x":10,"y":10,"deltaX":0,"deltaY":40}';
  const ACK = '{"_tag":"FrameAck"}';

  /** Sends a wheel that never finishes, then an acknowledgement; returns changes seen by the flow. */
  const acknowledgeBehindWheel = (killSwitch: boolean) =>
    Effect.gen(function* () {
      const previous = process.env.T3CODE_PERSONAL_BROWSER_ACK_FASTPATH;
      if (killSwitch) process.env.T3CODE_PERSONAL_BROWSER_ACK_FASTPATH = "off";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.T3CODE_PERSONAL_BROWSER_ACK_FASTPATH;
          else process.env.T3CODE_PERSONAL_BROWSER_ACK_FASTPATH = previous;
        }),
      );
      const flow = new ViewerFlow();
      const outbox = yield* Queue.unbounded<string>();
      const viewer: ViewerHandle = {
        id: 1,
        sessionId: "session-1",
        canOperate: true,
        outbox,
        flow,
        telemetry: null,
      };
      const gate = yield* Deferred.make<void>();
      const handled: string[] = [];
      const port = yield* serveViewerRoute(viewer, (raw) =>
        raw.includes("Wheel")
          ? Deferred.await(gate).pipe(Effect.andThen(Effect.sync(() => handled.push("wheel"))))
          : Effect.sync(() => {
              handled.push("other");
              if (raw.includes("FrameAck")) flow.acknowledge();
            }),
      );
      let acks = 0;
      flow.subscribe(() => {
        acks += 1;
      });
      yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<WebSocket>((resolve, reject) => {
              const socket = new WebSocket(`ws://127.0.0.1:${port}/api/personal/browser/stream`);
              socket.addEventListener("open", () => {
                socket.send(WHEEL);
                socket.send(ACK);
                resolve(socket);
              });
              socket.addEventListener("error", () => reject(new Error("socket error")), {
                once: true,
              });
            }),
        ),
        (socket) => Effect.sync(() => socket.close()),
      );
      yield* Effect.sleep(150);
      const whileWheelBlocked = acks;
      yield* Deferred.succeed(gate, undefined);
      yield* Effect.sleep(100);
      return { whileWheelBlocked, afterRelease: acks, handled };
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));

  it.live("acknowledges a frame at once, ahead of the input still being dispatched", () =>
    Effect.gen(function* () {
      const result = yield* acknowledgeBehindWheel(false);
      expect(result.whileWheelBlocked).toBe(1);
      // The wheel still ran, and the acknowledgement was not passed on twice.
      expect(result.handled).toEqual(["wheel"]);
    }),
  );

  it.live("with the kill switch the acknowledgement waits its turn, as before", () =>
    Effect.gen(function* () {
      const result = yield* acknowledgeBehindWheel(true);
      expect(result.whileWheelBlocked).toBe(0);
      expect(result.afterRelease).toBe(1);
      expect(result.handled).toEqual(["wheel", "other"]);
    }),
  );
});

// While the worker is busy with one input, wheels waiting behind it merge; a tap in
// between ends the run and nothing changes order.
describe("scroll steps queued behind a busy worker", () => {
  const wheel = (deltaY: number) => `{"_tag":"Wheel","x":10,"y":10,"deltaX":0,"deltaY":${deltaY}}`;
  const TAP = '{"_tag":"Pointer","action":"tap","x":5,"y":5}';

  const handledAfterBurst = (killSwitch: boolean) =>
    Effect.gen(function* () {
      const previous = process.env.T3CODE_PERSONAL_BROWSER_WHEEL_COALESCE;
      if (killSwitch) process.env.T3CODE_PERSONAL_BROWSER_WHEEL_COALESCE = "off";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.T3CODE_PERSONAL_BROWSER_WHEEL_COALESCE;
          else process.env.T3CODE_PERSONAL_BROWSER_WHEEL_COALESCE = previous;
        }),
      );
      const flow = new ViewerFlow();
      const outbox = yield* Queue.unbounded<string>();
      const viewer: ViewerHandle = {
        id: 1,
        sessionId: "session-1",
        canOperate: true,
        outbox,
        flow,
        telemetry: null,
      };
      const gate = yield* Deferred.make<void>();
      const handled: string[] = [];
      const port = yield* serveViewerRoute(viewer, (raw) =>
        Effect.gen(function* () {
          // The first wheel stays in "Chrome" until the whole burst has been queued.
          if (handled.length === 0) yield* Deferred.await(gate);
          handled.push(raw);
        }),
      );
      yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<WebSocket>((resolve, reject) => {
              const socket = new WebSocket(`ws://127.0.0.1:${port}/api/personal/browser/stream`);
              socket.addEventListener("open", () => {
                socket.send(wheel(1));
                // Let the worker take the first wheel and stay busy with it.
                setTimeout(() => {
                  for (const deltaY of [2, 3, 4, 5]) socket.send(wheel(deltaY));
                  socket.send(TAP);
                  for (const deltaY of [6, 7]) socket.send(wheel(deltaY));
                  resolve(socket);
                }, 100);
              });
              socket.addEventListener("error", () => reject(new Error("socket error")), {
                once: true,
              });
            }),
        ),
        (socket) => Effect.sync(() => socket.close()),
      );
      yield* Effect.sleep(200);
      yield* Deferred.succeed(gate, undefined);
      yield* Effect.sleep(200);
      return handled.map((raw) => JSON.parse(raw) as { _tag: string; deltaY?: number });
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));

  it.live("merges the wheels that waited, keeps the order, and never merges across a tap", () =>
    Effect.gen(function* () {
      const handled = yield* handledAfterBurst(false);
      expect(handled.map((entry) => [entry._tag, entry.deltaY])).toEqual([
        ["Wheel", 1],
        ["Wheel", 14],
        ["Pointer", undefined],
        ["Wheel", 13],
      ]);
    }),
  );

  it.live("with the kill switch every step is handled on its own, as before", () =>
    Effect.gen(function* () {
      const handled = yield* handledAfterBurst(true);
      expect(handled.map((entry) => entry.deltaY)).toEqual([1, 2, 3, 4, 5, undefined, 6, 7]);
    }),
  );
});
