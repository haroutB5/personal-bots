// @effect-diagnostics nodeBuiltinImport:off - real temp program files and a real worker launch back these tests.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  makeSpawnImageWarmer,
  spawnWarmupEnabled,
  type SpawnImageWarmer,
  type SpawnWarmupResult,
  withSpawnImageWarmup,
  withSpawnImageWarmupLayer,
} from "./spawnImageWarmup.ts";

const BIG = 64 * 1024 * 1024;

const programFile = (identity: string, size = BIG) => ({ isFile: true, size, identity });

function harness(overrides: Parameters<typeof makeSpawnImageWarmer>[0] = {}) {
  let clock = 1_000_000;
  let identity = "a";
  const launched: Array<string> = [];
  const warmer = makeSpawnImageWarmer({
    platform: "win32",
    enabled: () => true,
    now: () => clock,
    stat: async () => programFile(identity),
    launch: async (file) => {
      launched.push(file);
    },
    ...overrides,
  });
  return {
    warmer,
    launched,
    advance: (ms: number) => {
      clock += ms;
    },
    replaceFile: (next: string) => {
      identity = next;
    },
  };
}

const outcome = async (result: Promise<SpawnWarmupResult>) => (await result).outcome;

describe("makeSpawnImageWarmer", () => {
  const claude = "C:\\Users\\tester\\.local\\bin\\claude.exe";

  it("does nothing off Windows or with the switch off", async () => {
    expect(await outcome(harness({ platform: "linux" }).warmer.warm(claude))).toBe("off");
    expect(await outcome(harness({ enabled: () => false }).warmer.warm(claude))).toBe("off");
    expect(spawnWarmupEnabled({})).toBe(true);
    for (const value of ["off", "0", "false", "no", " Off "]) {
      expect(spawnWarmupEnabled({ T3CODE_SPAWN_WARMUP: value })).toBe(false);
    }
  });

  it("skips scripts, relative paths, missing and small files", async () => {
    const small = harness({ stat: async () => programFile("a", 1024 * 1024) });
    expect(await outcome(small.warmer.warm(claude))).toBe("skipped");
    const missing = harness({
      stat: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(await outcome(missing.warmer.warm(claude))).toBe("skipped");
    const { warmer, launched } = harness();
    expect(await outcome(warmer.warm("C:\\npm\\codex.cmd"))).toBe("skipped");
    expect(await outcome(warmer.warm("claude.exe"))).toBe("skipped");
    expect(launched).toEqual([]);
    expect(small.launched).toEqual([]);
  });

  it("warms a program once, again when its file changes, and again after the TTL", async () => {
    const { warmer, launched, advance, replaceFile } = harness({ ttlMs: 60_000 });
    expect(await outcome(warmer.warm(claude))).toBe("warmed");
    expect(await outcome(warmer.warm(claude.toUpperCase()))).toBe("warm");
    advance(59_000);
    expect(await outcome(warmer.warm(claude))).toBe("warm");
    replaceFile("b");
    expect(await outcome(warmer.warm(claude))).toBe("warmed");
    advance(60_000);
    expect(await outcome(warmer.warm(claude))).toBe("warmed");
    expect(launched).toHaveLength(3);
  });

  it("shares one warm-up between callers that ask at the same time", async () => {
    let release: () => void = () => undefined;
    const launched: Array<string> = [];
    const warmer = makeSpawnImageWarmer({
      platform: "win32",
      enabled: () => true,
      stat: async () => programFile("a"),
      launch: (file) => {
        launched.push(file);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const first = warmer.warm(claude);
    const second = warmer.warm(claude);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    expect(await outcome(first)).toBe("warmed");
    expect(await outcome(second)).toBe("warmed");
    expect(launched).toHaveLength(1);
  });

  it("fails open: a failed or slow warm-up is not remembered as warm", async () => {
    let attempts = 0;
    const failing = harness({
      launch: async () => {
        attempts += 1;
        throw new Error("blocked by policy");
      },
    });
    expect(await outcome(failing.warmer.warm(claude))).toBe("failed");
    expect(await outcome(failing.warmer.warm(claude))).toBe("failed");
    expect(attempts).toBe(2);

    const slow = harness({ timeoutMs: 20, launch: () => new Promise<void>(() => undefined) });
    expect(await outcome(slow.warmer.warm(claude))).toBe("timeout");
  });

  it.skipIf(process.platform !== "win32")(
    "starts and ends a real program on the worker thread",
    async () => {
      // node.exe is well above the size floor and is already checked, so this is quick.
      const warmer = makeSpawnImageWarmer();
      const first = await warmer.warm(process.execPath);
      expect(first.outcome).toBe("warmed");
      expect((await warmer.warm(process.execPath)).outcome).toBe("warm");
      const missing = NodePath.join(NodeOS.tmpdir(), "spawn-warmup-missing.exe");
      expect((await warmer.warm(missing)).outcome).toBe("skipped");
    },
    30_000,
  );

  it.skipIf(process.platform !== "win32")(
    "reports a program Windows cannot start as failed",
    async () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "spawn-warmup-"));
      const fake = NodePath.join(dir, "not-a-program.exe");
      NodeFS.writeFileSync(fake, Buffer.alloc(1024));
      try {
        const warmer = makeSpawnImageWarmer({ minBytes: 1 });
        expect((await warmer.warm(fake)).outcome).toBe("failed");
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

function emptyProcessHandle() {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("withSpawnImageWarmup", () => {
  const recording = () => {
    const events: Array<string> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        events.push(`spawn ${(command as ChildProcess.StandardCommand).command}`);
        return emptyProcessHandle();
      }),
    );
    const warmer: SpawnImageWarmer = {
      warm: async (file) => {
        events.push(`warm ${file}`);
        return { outcome: "warmed", ms: 0 };
      },
    };
    return { events, spawner, warmer };
  };

  it.effect("warms the program before it is spawned, and passes the command through", () => {
    const { events, spawner, warmer } = recording();
    const program = process.execPath;
    return Effect.gen(function* () {
      const exitCode = yield* withSpawnImageWarmup(spawner, warmer, "win32").exitCode(
        ChildProcess.make(program, ["--version"]),
      );
      expect(exitCode).toBe(0);
      expect(events).toEqual([`warm ${program}`, `spawn ${program}`]);
    });
  });

  it.effect("leaves shell launches, other platforms and missing programs alone", () => {
    const { events, spawner, warmer } = recording();
    return Effect.gen(function* () {
      yield* withSpawnImageWarmup(spawner, warmer, "win32").exitCode(
        ChildProcess.make("C:\\npm\\codex.cmd", [], { shell: true }),
      );
      yield* withSpawnImageWarmup(spawner, warmer, "linux").exitCode(
        ChildProcess.make(process.execPath, []),
      );
      yield* withSpawnImageWarmup(spawner, warmer, "win32").exitCode(
        ChildProcess.make("C:\\nowhere\\missing-program.exe", []),
      );
      expect(events).toEqual([
        "spawn C:\\npm\\codex.cmd",
        `spawn ${process.execPath}`,
        "spawn C:\\nowhere\\missing-program.exe",
      ]);
    });
  });
});

describe("withSpawnImageWarmupLayer", () => {
  it.effect("hands consumers the warming spawner, built on the platform's own", () => {
    const spawned: Array<string> = [];
    const base = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawned.push((command as ChildProcess.StandardCommand).command);
        return emptyProcessHandle();
      }),
    );
    const platform = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, base);
    return Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      expect(spawner).not.toBe(base);
      yield* spawner.exitCode(ChildProcess.make("C:\npm\tool.cmd", [], { shell: true }));
      expect(spawned).toEqual(["C:\npm\tool.cmd"]);
    }).pipe(Effect.provide(withSpawnImageWarmupLayer(platform)));
  });
});
