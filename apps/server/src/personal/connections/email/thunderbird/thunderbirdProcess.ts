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

const MAIN_NAMES: ReadonlySet<string> = new Set(["thunderbird", "thunderbird-bin"]);

/**
 * The main Thunderbird processes started on `profile`, read from a
 * /proc-shaped folder. A process counts when the program it was started as is
 * Thunderbird itself and it was given that profile with `-P`, which leaves out
 * a shell or editor that merely has the word in an argument, the owner's own
 * Thunderbird on another profile, and content children (`-contentproc`).
 */
export const findThunderbirdPids = (
  procRoot: string,
  profile: string = THUNDERBIRD_PROFILE_NAME,
): ReadonlyArray<number> => {
  let entries: ReadonlyArray<string>;
  try {
    entries = NodeFS.readdirSync(procRoot);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!/^\d+$/.test(entry)) return [];
    try {
      const argv = NodeFS.readFileSync(NodePath.join(procRoot, entry, "cmdline"), "utf8").split(
        "\0",
      );
      const program = NodePath.basename(argv[0] ?? "");
      const flag = argv.indexOf("-P");
      return MAIN_NAMES.has(program) &&
        !argv.includes("-contentproc") &&
        flag >= 0 &&
        argv[flag + 1] === profile
        ? [Number(entry)]
        : [];
    } catch {
      return [];
    }
  });
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
});

export class ThunderbirdProcess extends Context.Service<
  ThunderbirdProcess,
  {
    readonly running: () => Effect.Effect<boolean>;
    readonly launch: () => Effect.Effect<void, ThunderbirdProcessError>;
    /** Asks the hbots profile's Thunderbird to quit and waits until it has. Never forces it. */
    readonly terminate: () => Effect.Effect<void, ThunderbirdProcessError>;
  }
>()("t3/personal/connections/email/thunderbird/ThunderbirdProcess") {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const makeThunderbirdProcess = (config: ThunderbirdProcessConfig) =>
  ThunderbirdProcess.of({
    running: () =>
      Effect.sync(() => findThunderbirdPids(config.procRoot, config.profile).length > 0),
    launch: () =>
      Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
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
          }),
        catch: () => new ThunderbirdProcessError({ message: "Thunderbird could not be started." }),
      }),
    terminate: () =>
      Effect.tryPromise({
        try: async () => {
          const captured = findThunderbirdPids(config.procRoot, config.profile);
          for (const pid of captured) process.kill(pid, "SIGTERM");
          const deadline = Date.now() + config.exitWaitMs;
          while (Date.now() < deadline) {
            const alive = findThunderbirdPids(config.procRoot, config.profile).filter((pid) =>
              captured.includes(pid),
            );
            if (alive.length === 0) return;
            await sleep(200);
          }
          throw new Error("still running");
        },
        catch: () => new ThunderbirdProcessError({ message: "Thunderbird did not close in time." }),
      }),
  });

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
