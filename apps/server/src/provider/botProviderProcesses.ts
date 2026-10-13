/**
 * Which bot chat each live provider process belongs to.
 *
 * The Performance tab groups a bot's CPU and memory by its CLI's process tree.
 * A Claude CLI names its session on the command line (`--session-id=` when the
 * chat started it, `--resume=` when it continues one), so the tab matches that
 * against the chat that resumes the session. A Codex app-server names nothing
 * on its command line at all, so its spawn site records the PID here as the
 * process starts and the tab matches the PID instead.
 *
 * Keyed by chat: a resumed session replaces the process it left behind, and a
 * PID now used by another chat is dropped as it is registered (that number was
 * reused, so the old entry cannot still be that bot's CLI). A chat whose CLI
 * exits while the server keeps running keeps its last entry until the chat
 * spawns again; a stale PID matches nothing in a process snapshot, so it is
 * harmless, and the reused-PID rule above is what stops it mattering later.
 *
 * @module provider/botProviderProcesses
 */
export interface BotProviderProcess {
  readonly threadId: string;
  readonly provider: string;
  readonly pid: number;
}

const live = new Map<string, BotProviderProcess>();

/**
 * Record the process a provider session just started, under the chat that owns
 * it. Answers the entry it stored, or null for a PID that cannot be a process
 * (the Windows idle and system PIDs are never it).
 */
export function registerBotProviderProcess(input: {
  readonly threadId: string;
  readonly provider: string;
  readonly pid: number;
}): BotProviderProcess | null {
  if (!Number.isInteger(input.pid) || input.pid <= 4) return null;
  const entry: BotProviderProcess = {
    threadId: input.threadId,
    provider: input.provider,
    pid: input.pid,
  };
  for (const [threadId, known] of live) {
    if (known.pid === entry.pid && threadId !== entry.threadId) live.delete(threadId);
  }
  live.set(entry.threadId, entry);
  return entry;
}

/**
 * Drop a chat's process once it has ended. `pid` names the process that ended:
 * a chat that has already spawned a newer one keeps that newer entry.
 */
export function forgetBotProviderProcess(threadId: string, pid?: number): void {
  const known = live.get(threadId);
  if (known === undefined) return;
  if (pid !== undefined && known.pid !== pid) return;
  live.delete(threadId);
}

/** Every recorded process, for the Performance tab's attribution. */
export function listBotProviderProcesses(): ReadonlyArray<BotProviderProcess> {
  return [...live.values()];
}

/** Tests only: forget every recorded process. */
export function resetBotProviderProcesses(): void {
  live.clear();
}
