/**
 * Each provider spawn path lowers its process to BelowNormal by PID, and the
 * kill switch skips it. The spawner is a fake whose process never produces
 * output: the runtime is started, the priority call is awaited, then the
 * runtime is interrupted.
 */
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";

import { BOT_PROCESS_PRIORITY_ENV } from "./botProcessPriority.ts";
import { make as makeAcpSessionRuntime } from "./acp/AcpSessionRuntime.ts";
import { makeCodexSessionRuntime } from "./Layers/CodexSessionRuntime.ts";
import { OpenCodeRuntime, OpenCodeRuntimeLive } from "./opencodeRuntime.ts";

const lowered = vi.hoisted(() => [] as Array<{ pid: number; priority: number }>);

vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return {
    ...os,
    setPriority: (pid: number, priority: number) => void lowered.push({ pid, priority }),
  };
});

const FAKE_PID = 424_242;
const BELOW_NORMAL = 10;

const spawned: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
const fakeSpawner = ChildProcessSpawner.make((command) =>
  Effect.sync(() => {
    const input = command as unknown as {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    };
    spawned.push(input);
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(FAKE_PID),
      exitCode: Effect.never,
      isRunning: Effect.succeed(true),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.never,
      stderr: Stream.never,
      all: Stream.never,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.never,
    });
  }),
);

const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner);

/** Starts `start`, waits until it has spawned (and had its chance to lower), then stops it. */
const startAndStop = <A, E, R>(start: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(start);
    for (let attempt = 0; attempt < 300 && spawned.length === 0; attempt++) {
      yield* Effect.sleep("10 millis");
    }
    // The call under test follows the spawn on the same fiber.
    yield* Effect.sleep("100 millis");
    yield* Fiber.interrupt(fiber);
  });

const startCodex = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  yield* makeCodexSessionRuntime({
    threadId: ThreadId.make("thread-priority"),
    binaryPath: "codex",
    cwd: process.cwd(),
    runtimeMode: "full-access",
  }).pipe(Effect.provideService(Scope.Scope, scope));
});

const startAcp = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  yield* makeAcpSessionRuntime({
    spawn: { command: "acp-agent", args: [] },
    cwd: process.cwd(),
    clientInfo: { name: "test", version: "0.0.0" },
    authMethodId: "none",
  }).pipe(Effect.provideService(Scope.Scope, scope));
});

const startOpenCode = Effect.gen(function* () {
  const runtime = yield* OpenCodeRuntime;
  yield* runtime.startOpenCodeServerProcess({
    binaryPath: "opencode",
    directory: process.cwd(),
    port: 45_678,
    timeoutMs: 60_000,
  });
});

const baseLayer = spawnerLayer.pipe(Layer.provideMerge(NodeServices.layer));
const openCodeLayer = OpenCodeRuntimeLive.pipe(
  Layer.provide(spawnerLayer),
  Layer.provideMerge(NodeServices.layer),
);

const spawnPaths: ReadonlyArray<{ readonly name: string; readonly run: Effect.Effect<void> }> = [
  {
    name: "Codex app-server",
    run: startAndStop(startCodex).pipe(Effect.scoped, Effect.provide(baseLayer)),
  },
  {
    name: "ACP agent (Cursor, Grok, Antigravity)",
    run: startAndStop(startAcp).pipe(Effect.scoped, Effect.provide(baseLayer)),
  },
  {
    name: "OpenCode serve",
    run: startAndStop(startOpenCode).pipe(Effect.scoped, Effect.provide(openCodeLayer)),
  },
];

// The priority call is Windows-only by design; other platforms skip the lowering.
// oxlint-disable-next-line t3code/no-global-process-runtime -- the skip decision needs the real host platform, outside any Effect runtime.
describe.skipIf(NodeOS.platform() !== "win32")(
  "provider spawn paths lower the process priority",
  () => {
    const savedEnv = process.env[BOT_PROCESS_PRIORITY_ENV];
    beforeEach(() => {
      lowered.length = 0;
      spawned.length = 0;
      delete process.env[BOT_PROCESS_PRIORITY_ENV];
    });
    afterEach(() => {
      if (savedEnv === undefined) delete process.env[BOT_PROCESS_PRIORITY_ENV];
      else process.env[BOT_PROCESS_PRIORITY_ENV] = savedEnv;
    });

    for (const path of spawnPaths) {
      it.live(`${path.name}: BelowNormal on the spawned PID`, () =>
        path.run.pipe(
          Effect.map(() => {
            expect(spawned.length).toBeGreaterThan(0);
            expect(lowered).toEqual([{ pid: FAKE_PID, priority: BELOW_NORMAL }]);
          }),
        ),
      );

      it.live(`${path.name}: PERSONAL_BOT_PROCESS_PRIORITY=normal skips it`, () => {
        process.env[BOT_PROCESS_PRIORITY_ENV] = "normal";
        return path.run.pipe(
          Effect.map(() => {
            expect(spawned.length).toBeGreaterThan(0);
            expect(lowered).toEqual([]);
          }),
        );
      });
    }
  },
);
