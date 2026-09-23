/**
 * How long a "viewing this chat" report holds without a refresh. Clients
 * refresh every 10 s while the chat is open and visible, so one lost
 * heartbeat is tolerated. A report is only a hint: a notification for a
 * viewed chat is still sent to the viewing page, which must confirm it is on
 * screen, or it goes out as web push (iOS can lock without telling the page).
 */
export const PERSONAL_VIEWING_TTL_MS = 20_000;

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
    return this.viewers(threadId, nowMs).length > 0;
  }

  /** The connections that say they have `threadId` open and visible. Prunes expired entries. */
  viewers(threadId: string, nowMs: number): ReadonlyArray<string> {
    const out: string[] = [];
    for (const [connectionId, entry] of this.#entries) {
      if (nowMs - entry.lastSeenMs >= PERSONAL_VIEWING_TTL_MS) {
        this.#entries.delete(connectionId);
        continue;
      }
      if (entry.threadId === threadId) out.push(connectionId);
    }
    return out;
  }
}

/**
 * How recent a "the app is in front" report must be to count. Clients
 * heartbeat every 10 s while visible, so one lost report is tolerated. A
 * phone that locks without saying so is still covered: an in-app
 * notification nobody acknowledges falls back to web push.
 */
export const PERSONAL_FOREGROUND_FRESH_MS = 20_000;

/**
 * Which connections have the app on screen and are listening for in-app
 * notifications. Both halves are needed: a visible page without the stream
 * cannot show a banner, and a listening page in the background cannot be
 * seen. In memory only, like ViewingPresence.
 */
export class ForegroundPresence {
  readonly #visibleAt = new Map<string, number>();
  readonly #listeners = new Map<string, number>();

  report(connectionId: string, foreground: boolean, nowMs: number): void {
    if (foreground) this.#visibleAt.set(connectionId, nowMs);
    else this.#visibleAt.delete(connectionId);
  }

  /** A listener opened on this connection; call the returned function when it closes. */
  listen(connectionId: string): () => void {
    this.#listeners.set(connectionId, (this.#listeners.get(connectionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.#listeners.get(connectionId) ?? 1) - 1;
      if (left <= 0) this.#listeners.delete(connectionId);
      else this.#listeners.set(connectionId, left);
    };
  }

  drop(connectionId: string): void {
    this.#visibleAt.delete(connectionId);
  }

  /** Whether this connection has an in-app listener open. */
  isListening(connectionId: string): boolean {
    return (this.#listeners.get(connectionId) ?? 0) > 0;
  }

  /** Connections in front and listening right now. Prunes stale reports. */
  targets(nowMs: number): ReadonlyArray<string> {
    const out: string[] = [];
    for (const [connectionId, seenMs] of this.#visibleAt) {
      if (nowMs - seenMs >= PERSONAL_FOREGROUND_FRESH_MS) {
        this.#visibleAt.delete(connectionId);
        continue;
      }
      if ((this.#listeners.get(connectionId) ?? 0) > 0) out.push(connectionId);
    }
    return out;
  }
}
