// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - worker_threads and fs.promises have no Effect equivalent here, and the warm-up runs beside the fiber that will spawn.
/**
 * Starts a big program once on a worker thread before the server spawns it
 * (Windows), so the first-launch image check runs off the event loop. Fails
 * open, and `T3CODE_SPAWN_WARMUP=off` disables it.
 *
 * @module process/spawnImageWarmup
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";

import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  resolveSpawnExecutableWithNodeAsync,
  spawnAsyncResolveEnabled,
} from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** Smaller programs are checked in a few milliseconds (git.exe, taskkill.exe, cmd.exe). */
const SPAWN_WARMUP_MIN_BYTES = 16 * 1024 * 1024;
const SPAWN_WARMUP_TTL_MS = 5 * 60_000;
/** A warm-up that takes longer is given up on, and the launch goes ahead as before. */
const SPAWN_WARMUP_TIMEOUT_MS = 30_000;
/** Warm-ups at least this long are logged, so the live logs show what was kept off the loop. */
const SPAWN_WARMUP_LOG_MS = 250;
const MAX_TRACKED_PROGRAMS = 256;

export type SpawnWarmupOutcome =
  /** Switched off, or not Windows. */
  | "off"
  /** Not a program file, missing, or small. */
  | "skipped"
  /** Warmed recently and unchanged since. */
  | "warm"
  /** Started and ended on the worker just now. */
  | "warmed"
  | "failed"
  | "timeout";

export interface SpawnWarmupResult {
  readonly outcome: SpawnWarmupOutcome;
  readonly ms: number;
}

export function spawnWarmupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.T3CODE_SPAWN_WARMUP?.trim().toLowerCase();
  return !(value === "off" || value === "0" || value === "false" || value === "no");
}

interface ProgramFile {
  readonly isFile: boolean;
  readonly size: number;
  /** Changes when the file is replaced or rewritten. */
  readonly identity: string;
}

const statProgramFile = async (file: string): Promise<ProgramFile> => {
  const stat = await NodeFS.promises.stat(file, { bigint: true });
  return {
    isFile: stat.isFile(),
    size: Number(stat.size),
    identity: `${stat.size}:${stat.mtimeNs}:${stat.ino}`,
  };
};

// Runs on the worker: start the program, end it as soon as it exists. By the
// time spawn() returns, Windows has checked and mapped the image; the process
// is ended before its own code runs (--version only in case it gets that far).
const SPAWN_WARMUP_WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { spawn } = require("node:child_process");
parentPort.on("message", ({ id, file }) => {
  let replied = false;
  const reply = (error) => {
    if (replied) return;
    replied = true;
    parentPort.postMessage({ id, error });
  };
  let child;
  try {
    child = spawn(file, ["--version"], { stdio: "ignore", windowsHide: true });
  } catch (error) {
    reply(String((error && error.message) || error));
    return;
  }
  child.once("error", (error) => reply(String((error && error.message) || error)));
  child.once("spawn", () => {
    try {
      child.kill();
    } catch {}
    reply(null);
  });
});
`;

interface PendingLaunch {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

/** One small worker, started on first use, restarted if it dies. */
const makeWorkerLauncher = () => {
  let worker: NodeWorkerThreads.Worker | undefined;
  let nextId = 1;
  const pending = new Map<number, PendingLaunch>();

  const failAll = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  const ensureWorker = () => {
    if (worker !== undefined) return worker;
    const created = new NodeWorkerThreads.Worker(SPAWN_WARMUP_WORKER_SOURCE, {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 },
    });
    created.unref();
    created.on("message", (message: { id: number; error: string | null }) => {
      const entry = pending.get(message.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      if (message.error === null) entry.resolve();
      else entry.reject(new Error(message.error));
    });
    const retire = (error: Error) => {
      if (worker === created) worker = undefined;
      failAll(error);
    };
    created.on("error", (error) =>
      retire(error instanceof Error ? error : new Error(String(error))),
    );
    created.on("exit", (code) => retire(new Error(`spawn warm-up worker exited (${code})`)));
    worker = created;
    return created;
  };

  return (file: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker thread, not window.postMessage.
        ensureWorker().postMessage({ id, file });
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
};

export interface SpawnImageWarmerOptions {
  readonly platform?: NodeJS.Platform;
  readonly enabled?: () => boolean;
  readonly minBytes?: number;
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly stat?: (file: string) => Promise<ProgramFile>;
  /** Starts and ends the program off the event loop; rejects when it cannot be started. */
  readonly launch?: (file: string) => Promise<void>;
}

export interface SpawnImageWarmer {
  /** Never rejects. `file` must be a full path. */
  readonly warm: (file: string) => Promise<SpawnWarmupResult>;
}

export function makeSpawnImageWarmer(options: SpawnImageWarmerOptions = {}): SpawnImageWarmer {
  const platform = options.platform ?? HostProcess.Platform.defaultValue();
  const enabled = options.enabled ?? (() => spawnWarmupEnabled());
  const minBytes = options.minBytes ?? SPAWN_WARMUP_MIN_BYTES;
  const ttlMs = options.ttlMs ?? SPAWN_WARMUP_TTL_MS;
  const timeoutMs = options.timeoutMs ?? SPAWN_WARMUP_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const stat = options.stat ?? statProgramFile;
  let launch = options.launch;
  const warmed = new Map<string, { readonly identity: string; readonly at: number }>();
  const inFlight = new Map<string, Promise<SpawnWarmupResult>>();

  const run = async (key: string, file: string): Promise<SpawnWarmupResult> => {
    const startedAt = now();
    const elapsed = () => Math.max(0, now() - startedAt);
    let program: ProgramFile;
    try {
      program = await stat(file);
    } catch {
      return { outcome: "skipped", ms: elapsed() };
    }
    if (!program.isFile || program.size < minBytes) return { outcome: "skipped", ms: elapsed() };
    const previous = warmed.get(key);
    if (
      previous !== undefined &&
      previous.identity === program.identity &&
      now() - previous.at < ttlMs
    ) {
      return { outcome: "warm", ms: elapsed() };
    }
    launch ??= makeWorkerLauncher();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      timer.unref?.();
    });
    try {
      const result = await Promise.race([launch(file).then(() => "warmed" as const), timedOut]);
      if (result === "timeout") return { outcome: "timeout", ms: elapsed() };
      warmed.delete(key);
      if (warmed.size >= MAX_TRACKED_PROGRAMS) {
        const oldest = warmed.keys().next().value;
        if (oldest !== undefined) warmed.delete(oldest);
      }
      warmed.set(key, { identity: program.identity, at: now() });
      return { outcome: "warmed", ms: elapsed() };
    } catch {
      return { outcome: "failed", ms: elapsed() };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return {
    warm: (file) => {
      if (platform !== "win32" || !enabled()) return Promise.resolve({ outcome: "off", ms: 0 });
      const extension = NodePath.win32.extname(file).toLowerCase();
      if (!NodePath.win32.isAbsolute(file) || (extension !== ".exe" && extension !== ".com")) {
        return Promise.resolve({ outcome: "skipped", ms: 0 });
      }
      const key = NodePath.win32.normalize(file).toLowerCase();
      const running = inFlight.get(key);
      if (running !== undefined) return running;
      const started = run(key, file).finally(() => inFlight.delete(key));
      inFlight.set(key, started);
      return started;
    },
  };
}

/** The server's one warmer: every spawn site shares what has been warmed. */
const spawnImageWarmer = makeSpawnImageWarmer();

const logSlowWarmup = (file: string, result: SpawnWarmupResult) =>
  result.ms >= SPAWN_WARMUP_LOG_MS
    ? Effect.logInfo("program launch checked off the event loop", {
        file,
        outcome: result.outcome,
        ms: Math.round(result.ms),
      })
    : Effect.void;

/** Warms `file` (a full path) before the caller spawns it. Never fails. */
export const warmSpawnImage = (
  file: string,
  warmer: SpawnImageWarmer = spawnImageWarmer,
): Effect.Effect<void> =>
  Effect.promise(() => warmer.warm(file)).pipe(
    Effect.flatMap((result) => logSlowWarmup(file, result)),
  );

const standardCommands = (
  command: ChildProcess.Command,
): ReadonlyArray<ChildProcess.StandardCommand> =>
  ChildProcess.isStandardCommand(command)
    ? [command]
    : [...standardCommands(command.left), ...standardCommands(command.right)];

/** The program a command starts directly, as NodeChildProcessSpawner would launch it. */
const programFileOf = async (
  command: ChildProcess.StandardCommand,
): Promise<string | undefined> => {
  // A shell launch starts cmd.exe; the program itself is then started by cmd.exe, not by us.
  if (command.options.shell !== undefined && command.options.shell !== false) return undefined;
  const env = command.options.extendEnv
    ? { ...process.env, ...command.options.env }
    : (command.options.env ?? process.env);
  const plainEnv = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      value === undefined || typeof value === "string" ? value : Redacted.value(value),
    ]),
  );
  if (!spawnAsyncResolveEnabled()) {
    return NodePath.win32.isAbsolute(command.command) ? command.command : undefined;
  }
  return resolveSpawnExecutableWithNodeAsync(command.command, "win32", plainEnv);
};

const warmCommandImages = (
  command: ChildProcess.Command,
  warmer: SpawnImageWarmer,
): Effect.Effect<void> =>
  Effect.forEach(
    standardCommands(command),
    (standard) =>
      Effect.promise(() => programFileOf(standard)).pipe(
        Effect.flatMap((file) => (file === undefined ? Effect.void : warmSpawnImage(file, warmer))),
      ),
    { concurrency: "unbounded", discard: true },
  );

const WARMING_SPAWNER = Symbol.for("t3code/process/spawnImageWarmup");

/**
 * A ChildProcessSpawner that warms each program it is about to start. On other
 * platforms, or with the switch off, it costs one check per spawn. Wrapping a
 * spawner that already warms returns it unchanged.
 */
export const withSpawnImageWarmup = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  warmer: SpawnImageWarmer = spawnImageWarmer,
  platform: NodeJS.Platform = HostProcess.Platform.defaultValue(),
): ChildProcessSpawner.ChildProcessSpawner["Service"] => {
  if (WARMING_SPAWNER in spawner) return spawner;
  return Object.assign(
    ChildProcessSpawner.make((command) =>
      platform === "win32" && spawnWarmupEnabled()
        ? warmCommandImages(command, warmer).pipe(Effect.andThen(spawner.spawn(command)))
        : spawner.spawn(command),
    ),
    { [WARMING_SPAWNER]: true },
  );
};

/** Replaces the ChildProcessSpawner below it with one that warms programs first. */
export const SpawnImageWarmupLive = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    return withSpawnImageWarmup(yield* ChildProcessSpawner.ChildProcessSpawner);
  }),
);

/**
 * `platform` (e.g. NodeServices.layer) with its ChildProcessSpawner replaced by
 * one that warms programs first. Everything else in `platform` is unchanged.
 */
export const withSpawnImageWarmupLayer = <ROut, E, RIn>(
  platform: Layer.Layer<ROut | ChildProcessSpawner.ChildProcessSpawner, E, RIn>,
): Layer.Layer<ROut | ChildProcessSpawner.ChildProcessSpawner, E, RIn> =>
  Layer.merge(platform, SpawnImageWarmupLive.pipe(Layer.provide(platform)));
