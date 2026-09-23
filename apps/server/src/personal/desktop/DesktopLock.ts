/**
 * Who may drive the user's PC. One bot holds it at a time; the rest wait in
 * line, first come first served. Pure state so the rules are tested without
 * a desktop: the service turns these transitions into waiting fibers,
 * overlay changes and status pushes.
 */

/** A bot that holds the PC this long without a desktop action loses it. */
export const DESKTOP_IDLE_TIMEOUT_MS = 2 * 60_000;

export interface DesktopClaimant {
  readonly threadId: string;
  readonly botId: string;
  readonly botName: string;
}

export interface DesktopHolderState extends DesktopClaimant {
  readonly since: number;
  readonly lastActionAt: number;
}

export type ClaimResult =
  | { readonly status: "granted"; readonly holder: DesktopHolderState }
  | {
      readonly status: "queued";
      /** 1 = next in line. */
      readonly position: number;
      readonly holder: DesktopHolderState;
    };

export interface HandOver {
  /** The holder that just lost the PC, if any. */
  readonly previous: DesktopHolderState | null;
  /** The next bot in line, which now holds it. */
  readonly promoted: DesktopHolderState | null;
}

const NO_CHANGE: HandOver = { previous: null, promoted: null };

export class DesktopLockCore {
  private holderState: DesktopHolderState | null = null;
  private line: Array<DesktopClaimant> = [];

  readonly idleTimeoutMs: number;

  constructor(idleTimeoutMs: number = DESKTOP_IDLE_TIMEOUT_MS) {
    this.idleTimeoutMs = idleTimeoutMs;
  }

  get holder(): DesktopHolderState | null {
    return this.holderState;
  }

  get waiting(): ReadonlyArray<DesktopClaimant> {
    return this.line;
  }

  /**
   * The holder keeps it (and its idle clock restarts); anyone else gets it
   * when it is free and nobody is ahead of them, otherwise joins the line
   * once, keeping their place on a repeat claim. Callers run
   * {@link expireIdle} first, so the hand-over it causes is not lost.
   */
  claim(claimant: DesktopClaimant, now: number): ClaimResult {
    if (this.holderState?.threadId === claimant.threadId) {
      this.holderState = { ...this.holderState, lastActionAt: now };
      return { status: "granted", holder: this.holderState };
    }
    if (this.holderState === null) {
      // Free, and nobody queued can be ahead: promotion empties the line
      // head as soon as the PC frees up, so a free PC means an empty line
      // or a line that starts with this claimant.
      this.line = this.line.filter((entry) => entry.threadId !== claimant.threadId);
      this.holderState = { ...claimant, since: now, lastActionAt: now };
      return { status: "granted", holder: this.holderState };
    }
    const existing = this.line.findIndex((entry) => entry.threadId === claimant.threadId);
    if (existing === -1) this.line.push(claimant);
    return {
      status: "queued",
      position: existing === -1 ? this.line.length : existing + 1,
      holder: this.holderState,
    };
  }

  /** The holder did something: restart its idle clock. */
  touch(threadId: string, now: number): void {
    if (this.holderState?.threadId === threadId) {
      this.holderState = { ...this.holderState, lastActionAt: now };
    }
  }

  isHolder(threadId: string): boolean {
    return this.holderState?.threadId === threadId;
  }

  /** Frees the PC if `threadId` holds it and hands it to the next in line. */
  release(threadId: string, now: number): HandOver {
    if (this.holderState?.threadId !== threadId) return NO_CHANGE;
    const previous = this.holderState;
    this.holderState = null;
    return { previous, promoted: this.promote(now) };
  }

  /** Leaves the line (a waiting call gave up or its turn ended). */
  leaveLine(threadId: string): boolean {
    const before = this.line.length;
    this.line = this.line.filter((entry) => entry.threadId !== threadId);
    return this.line.length !== before;
  }

  /** Takes the PC off a holder idle past the timeout. */
  expireIdle(now: number): HandOver {
    if (this.holderState === null) return NO_CHANGE;
    if (now - this.holderState.lastActionAt < this.idleTimeoutMs) return NO_CHANGE;
    return this.release(this.holderState.threadId, now);
  }

  /**
   * The user took the PC back: nobody keeps or gets it. Everyone waiting is
   * turned away too, because a person who just hit stop does not want the
   * next bot to start moving their mouse.
   */
  stopAll(): {
    readonly stopped: DesktopHolderState | null;
    readonly turnedAway: DesktopClaimant[];
  } {
    const stopped = this.holderState;
    const turnedAway = this.line;
    this.holderState = null;
    this.line = [];
    return { stopped, turnedAway };
  }

  private promote(now: number): DesktopHolderState | null {
    const next = this.line.shift();
    if (next === undefined) return null;
    this.holderState = { ...next, since: now, lastActionAt: now };
    return this.holderState;
  }
}
