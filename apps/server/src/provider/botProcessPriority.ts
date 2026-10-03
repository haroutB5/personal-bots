// @effect-diagnostics nodeBuiltinImport:off
/**
 * Starts every bot provider process at BelowNormal priority (Windows).
 *
 * The shared browser's live view lagged while bots ran CPU-heavy builds and
 * test suites: the server (AboveNormal) and Chrome (Normal) competed with a
 * `vp build` that also ran at Normal. A Windows child inherits its parent's
 * priority class only when the parent is Idle or BelowNormal, otherwise it
 * starts at Normal. So the provider process itself is lowered right after it
 * is spawned, by its known PID, and every shell command, build and test it
 * starts afterwards inherits BelowNormal. The server and the browser are not
 * touched here.
 *
 * `PERSONAL_BOT_PROCESS_PRIORITY=normal` (also `off`, `0`, `false`) turns this
 * off and restores the earlier behaviour.
 *
 * @module provider/botProcessPriority
 */
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
}

export type BotProcessPriorityResult =
  | { readonly status: "applied" }
  | { readonly status: "skipped"; readonly reason: "disabled" | "unsupported-platform" | "no-pid" }
  | { readonly status: "failed"; readonly code: string | undefined; readonly message: string };

/**
 * Lowers one process to BelowNormal. Never throws: a process that already
 * exited (ESRCH) or one that cannot be opened is reported, not raised, because
 * a bot must run whether or not its priority could be changed.
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
  if ((deps.platform ?? NodeOS.platform()) !== "win32") {
    return { status: "skipped", reason: "unsupported-platform" };
  }
  try {
    (deps.setPriority ?? NodeOS.setPriority)(pid, NodeOS.constants.priority.PRIORITY_BELOW_NORMAL);
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
export const lowerBotProcessPriorityEffect = (
  pid: number | undefined,
  provider: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const result = lowerBotProcessPriority(pid);
    if (result.status === "failed" && result.code !== "ESRCH") {
      yield* Effect.logWarning("Could not lower bot process priority.", {
        provider,
        pid,
        error: result.message,
      });
    }
  });
