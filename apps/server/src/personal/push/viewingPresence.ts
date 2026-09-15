/**
 * How long a "viewing this chat" report holds without a refresh. Clients
 * refresh every 20 s while the chat is open and visible, so one lost
 * heartbeat is tolerated; a phone that locks without saying so stops
 * holding notifications back within this window.
 */
export const PERSONAL_VIEWING_TTL_MS = 45_000;

interface ViewingEntry {
  readonly threadId: string;
  readonly lastSeenMs: number;
}

/**
 * In-memory "which chat is open on which connection". One entry per
 * websocket connection, so several devices (or tabs) each count. Nothing is
 * persisted: after a server restart every client re-reports within one
 * heartbeat, and until then notifications simply go out as before.
 */
export class ViewingPresence {
  readonly #entries = new Map<string, ViewingEntry>();

  /** `threadId` null means the connection has no chat open and visible. */
  report(connectionId: string, threadId: string | null, nowMs: number): void {
    if (threadId === null) {
      this.#entries.delete(connectionId);
      return;
    }
    this.#entries.set(connectionId, { threadId, lastSeenMs: nowMs });
  }

  /** The connection closed. */
  drop(connectionId: string): void {
    this.#entries.delete(connectionId);
  }

  /** Whether any live connection has `threadId` open and visible. Prunes expired entries. */
  isViewing(threadId: string, nowMs: number): boolean {
    let viewing = false;
    for (const [connectionId, entry] of this.#entries) {
      if (nowMs - entry.lastSeenMs >= PERSONAL_VIEWING_TTL_MS) {
        this.#entries.delete(connectionId);
        continue;
      }
      if (entry.threadId === threadId) viewing = true;
    }
    return viewing;
  }
}
