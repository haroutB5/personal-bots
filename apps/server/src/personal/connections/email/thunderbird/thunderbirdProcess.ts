import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { discoverGraphicalSession } from "../../../browser/headlessMode.ts";
import { THUNDERBIRD_PROFILE_NAME } from "./pins.ts";
import { resolveProfileDir } from "./profile.ts";

const MAIN_NAMES: ReadonlySet<string> = new Set(["thunderbird", "thunderbird-bin"]);

export interface RunningThunderbirdWhere {
  readonly home: string;
  readonly profile: string;
  readonly procRoot: string;
}

/**
 * The PID of the Thunderbird that holds the hbots profile, found through the
 * profile's own `lock` symlink (target `host:+PID`) and then confirmed by the
 * program that PID runs. How Thunderbird was started does not matter, and a
 * stale lock, a reused PID, a shell that merely mentions Thunderbird or a
 * Thunderbird on another profile or home all come back as null.
 */
export const runningThunderbirdPid = (where: RunningThunderbirdWhere): number | null => {
  const profileDir = resolveProfileDir(where.home, where.profile);
  if (profileDir === null) return null;
  let target: string;
  try {
    target = NodeFS.readlinkSync(NodePath.join(profileDir, "lock"));
  } catch {
    return null;
  }
  const digits = /:\+?(\d+)$/.exec(target)?.[1];
  if (digits === undefined) return null;
  const pid = Number(digits);
  try {
    const exe = NodeFS.readlinkSync(NodePath.join(where.procRoot, digits, "exe"));
    if (!MAIN_NAMES.has(NodePath.basename(exe.replace(/ \(deleted\)$/, "")))) return null;
    const argv = NodeFS.readFileSync(
      NodePath.join(where.procRoot, digits, "cmdline"),
      "utf8",
    ).split("\0");
    const named = argv.indexOf("-P");
    return named >= 0 && argv[named + 1] !== where.profile ? null : pid;
  } catch {
    return null;
  }
};

export class ThunderbirdProcessError extends Schema.TaggedError<ThunderbirdProcessError>()(
  "ThunderbirdProcessError",
  { message: Schema.String },
) {}

export interface ThunderbirdProcessConfig {
  readonly home: string;
  readonly binary: string;
  readonly profile: string;
  readonly procRoot: string;
  readonly graphicalEnv: () => Readonly<Record<string, string>>;
  readonly exitWaitMs: number;
  readonly startWaitMs: number;
}

export const defaultThunderbirdProcessConfig = (
  home: string = NodeOS.homedir(),
): ThunderbirdProcessConfig => ({
  home,
  binary: NodePath.join(home, ".local", "bin", "thunderbird"),
  profile: THUNDERBIRD_PROFILE_NAME,
  procRoot: "/proc",
  graphicalEnv: () => discoverGraphicalSession().env,
  exitWaitMs: 20_000,
  startWaitMs: 20_000,
});

export class ThunderbirdProcess extends Context.Service<
  ThunderbirdProcess,
  {
    readonly running: () => Effect.Effect<boolean>;
    /** Starts Thunderbird on the hbots profile and returns once a running Thunderbird holds that profile. */
    readonly launch: () => Effect.Effect<void, ThunderbirdProcessError>;
    /** Asks the hbots profile's Thunderbird to quit and fails unless it has exited. Never forces it. */
    readonly terminate: () => Effect.Effect<void, ThunderbirdProcessError>;
  }
>()("t3/personal/connections/email/thunderbird/ThunderbirdProcess") {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const until = async (done: () => boolean, waitMs: number): Promise<boolean> => {
  const deadline = Date.now() + waitMs;
  while (!done()) {
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
  return true;
};

export const makeThunderbirdProcess = (config: ThunderbirdProcessConfig) => {
  const pid = () => runningThunderbirdPid(config);
  return ThunderbirdProcess.of({
    running: () => Effect.sync(() => pid() !== null),
    launch: () =>
      Effect.tryPromise({
        try: async () => {
          await new Promise<void>((resolve, reject) => {
            const child = NodeChildProcess.spawn(config.binary, ["-P", config.profile], {
              detached: true,
              stdio: "ignore",
              env: {
                PATH: process.env["PATH"] ?? "/usr/bin:/bin",
                HOME: config.home,
                ...(process.env["XDG_RUNTIME_DIR"] === undefined
                  ? {}
                  : { XDG_RUNTIME_DIR: process.env["XDG_RUNTIME_DIR"] }),
                ...(process.env["LANG"] === undefined ? {} : { LANG: process.env["LANG"] }),
                ...config.graphicalEnv(),
              },
            });
            child.once("error", reject);
            child.once("spawn", () => {
              child.unref();
              resolve();
            });
          });
          if (!(await until(() => pid() !== null, config.startWaitMs))) {
            throw new Error("not locked");
          }
        },
        catch: () => new ThunderbirdProcessError({ message: "Thunderbird could not be started." }),
      }),
    terminate: () =>
      Effect.tryPromise({
        try: async () => {
          const captured = pid();
          if (captured === null) return;
          process.kill(captured, "SIGTERM");
          if (!(await until(() => pid() !== captured, config.exitWaitMs))) {
            throw new Error("still running");
          }
        },
        catch: () => new ThunderbirdProcessError({ message: "Thunderbird did not close in time." }),
      }),
  });
};

export const layerLive = (config: ThunderbirdProcessConfig = defaultThunderbirdProcessConfig()) =>
  Layer.succeed(ThunderbirdProcess, makeThunderbirdProcess(config));

export const layerOf = (running: boolean) =>
  Layer.succeed(
    ThunderbirdProcess,
    ThunderbirdProcess.of({
      running: () => Effect.succeed(running),
      launch: () => Effect.void,
      terminate: () => Effect.void,
    }),
  );
