// @effect-diagnostics nodeBuiltinImport:off
/**
 * Spawns the Claude Code CLI for a session and remembers its PID.
 *
 * The SDK does not expose the process it starts, so a session could stop its
 * CLI but not the shell commands that CLI started, which outlive it on Windows
 * (see `processTree.ts`). This spawner does what the SDK's own local spawn
 * does (`child_process.spawn`, three pipes, hidden window, the forwarded abort
 * signal) and records the child in a handle the session keeps.
 *
 * One difference: the SDK's own spawn folds the CLI's stderr into its exit
 * error, and a custom spawn cannot. The tail is kept here instead and logged
 * when the CLI exits abnormally. `PERSONAL_CLAUDE_SDK_SPAWN=1` turns this
 * spawner off (the SDK spawns as before, and deleting a chat no longer ends
 * its commands).
 *
 * @module provider/Layers/claudeProcessSpawner
 */
import * as NodeChildProcess from "node:child_process";

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import { lowerBotProcessPriority } from "../botProcessPriority.ts";

const STDERR_TAIL_CHARS = 8_192;

export interface ClaudeProcessHandle {
  /** The CLI process, once spawned. A session that resumes spawns again. */
  child: NodeChildProcess.ChildProcess | undefined;
  stderrTail: string;
  /** The session asked for this stop (an archive, a delete, a restart): the exit that follows is not a fault. */
  stopRequested: boolean;
}

export const makeClaudeProcessHandle = (): ClaudeProcessHandle => ({
  child: undefined,
  stderrTail: "",
  stopRequested: false,
});

/** The CLI's PID while it is still running, else undefined (a PID may be reused after exit). */
export function liveClaudeProcessPid(handle: ClaudeProcessHandle | undefined): number | undefined {
  const child = handle?.child;
  if (child === undefined || child.pid === undefined) return undefined;
  if (child.exitCode !== null || child.signalCode !== null) return undefined;
  return child.pid;
}

export function claudeSdkSpawnDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PERSONAL_CLAUDE_SDK_SPAWN === "1";
}

export function makeRecordingClaudeSpawner(
  handle: ClaudeProcessHandle,
  onAbnormalExit?: (detail: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderrTail: string;
    /** The session stopped the CLI on purpose, so this is an ordinary end, not a crash. */
    readonly requested: boolean;
  }) => void,
  lowerPriority: (pid: number | undefined) => void = (pid) => void lowerBotProcessPriority(pid),
): (options: SpawnOptions) => SpawnedProcess {
  return (options) => {
    const child = NodeChildProcess.spawn(options.command, options.args, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    // Every shell command and build this CLI runs inherits its priority class.
    lowerPriority(child.pid);
    handle.child = child;
    handle.stderrTail = "";
    // A resumed session spawns again: that process has not been asked to stop.
    handle.stopRequested = false;
    // Unread, a full stderr pipe would stall the CLI.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const next = handle.stderrTail + chunk;
      handle.stderrTail =
        next.length > STDERR_TAIL_CHARS ? next.slice(next.length - STDERR_TAIL_CHARS) : next;
    });
    child.stderr.on("error", () => undefined);
    child.once("exit", (code, signal) => {
      // An abort (session stop) ends the CLI on purpose and says nothing; a stop the session
      // asked for through the SDK (SIGTERM, then SIGKILL) is reported as such, and only an exit
      // nobody asked for is a fault.
      if (options.signal.aborted || code === 0) return;
      onAbnormalExit?.({
        code,
        signal,
        stderrTail: handle.stderrTail,
        requested: handle.stopRequested,
      });
    });
    return child as unknown as SpawnedProcess;
  };
}
