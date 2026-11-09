// @effect-diagnostics nodeBuiltinImport:off
/**
 * Lowers every bot provider process below normal (Windows BelowNormal, Linux
 * nice 10 + idle I/O) so it cannot starve the server or browser. Children
 * inherit it. `PERSONAL_BOT_PROCESS_PRIORITY=normal|off|0|false` disables it.
 * @module provider/botProcessPriority
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";

export const BOT_PROCESS_PRIORITY_ENV = "PERSONAL_BOT_PROCESS_PRIORITY";

/** True when the owner switched the lowering off. Anything else (including unset) keeps it on. */
export function botProcessPriorityDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[BOT_PROCESS_PRIORITY_ENV]?.trim().toLowerCase();
  return value === "normal" || value === "off" || value === "0" || value === "false";
}

export interface BotProcessPriorityDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly setPriority?: (pid: number, priority: number) => void;
  /** Best-effort idle I/O class on Linux; injected so tests never spawn. */
  readonly applyIoPriority?: (pid: number) => void;
}

export type BotProcessPriorityResult =
  | { readonly status: "applied" }
  | { readonly status: "skipped"; readonly reason: "disabled" | "unsupported-platform" | "no-pid" }
  | { readonly status: "failed"; readonly code: string | undefined; readonly message: string };

/**
 * Linux: move one process to the idle I/O class with `ionice -c 3`, by PID.
 * Best effort and detached: a machine without util-linux, or a PID that is
 * already gone, must not delay a bot's start.
 */
const applyLinuxIdleIo = (pid: number): void => {
  try {
    const child = NodeChildProcess.spawn("ionice", ["-c", "3", "-p", String(pid)], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // No ionice on this machine: nice below is still in effect.
  }
};

/**
 * Lowers one process below normal: BelowNormal on Windows, nice 10 on Linux.
 * Never throws: a process that already exited (ESRCH) or one that cannot be
 * opened is reported, not raised, because a bot must run whether or not its
 * priority could be changed.
 */
export function lowerBotProcessPriority(
  pid: number | undefined,
  deps: BotProcessPriorityDeps = {},
): BotProcessPriorityResult {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 4) {
    return { status: "skipped", reason: "no-pid" };
  }
  if (botProcessPriorityDisabled(deps.env)) return { status: "skipped", reason: "disabled" };
  // oxlint-disable-next-line t3code/no-global-process-runtime -- a synchronous spawn-time check outside any Effect runtime; tests inject the platform.
  const platform = deps.platform ?? NodeOS.platform();
  if (platform !== "win32" && platform !== "linux") {
    return { status: "skipped", reason: "unsupported-platform" };
  }
  try {
    // Node maps this to a Windows priority class or a POSIX nice value, and a
    // POSIX child inherits its parent's nice, so shell commands below inherit.
    (deps.setPriority ?? NodeOS.setPriority)(pid, NodeOS.constants.priority.PRIORITY_BELOW_NORMAL);
    if (platform === "linux") (deps.applyIoPriority ?? applyLinuxIdleIo)(pid);
    return { status: "applied" };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : undefined;
    return {
      status: "failed",
      code,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Effect form for the spawn sites. A failure is logged as a warning, except a
 * process that is already gone, which is routine and stays quiet.
 */
export const lowerBotProcessPriorityEffect = Effect.fn("lowerBotProcessPriorityEffect")(function* (
  pid: number | undefined,
  provider: string,
) {
  const result = lowerBotProcessPriority(pid);
  if (result.status === "failed" && result.code !== "ESRCH") {
    yield* Effect.logWarning("Could not lower bot process priority.", {
      provider,
      pid,
      error: result.message,
    });
  }
});
