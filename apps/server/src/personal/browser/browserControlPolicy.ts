/**
 * Who holds the shared browser when nobody is looking at it: the grace period
 * of a device that took control and then went away, and the idle close.
 * Pure state steps; the service reads the lease and the clock and acts.
 */

/** What the watchdog remembers between two checks. */
export interface ControlWatchState {
  /** A viewer of the controlling device has been seen since it took control. */
  readonly viewerSeen: boolean;
  /** Since when the controlling device has had no viewer, epoch ms; null = not absent. */
  readonly absentSince: number | null;
}

export type ControlWatchStep =
  | { readonly state: ControlWatchState; readonly action: "none" }
  | { readonly state: ControlWatchState; readonly action: "hand_back"; readonly absentMs: number };

/**
 * One check of the controlling device. Control goes back to the agent when
 * the device that took it has been gone for the grace period (a phone that
 * locked or lost signal mid-control used to keep bots out for good). Not
 * while a bot's help request is open: that task waits for this person, who may
 * finish on the laptop itself. A device that never opened a live view is never
 * handed back: its person may be typing into the laptop's Chrome window.
 *
 * `now` is read only when the check gets that far, as the service did.
 */
export const stepControlWatch = (input: {
  readonly graceMs: number;
  readonly ownerType: string;
  readonly ownerId: string | null;
  /** The sessions that have a live view open right now. */
  readonly viewerSessionIds: Iterable<string>;
  readonly helpOpen: boolean;
  readonly state: ControlWatchState;
  readonly now: () => number;
}): ControlWatchStep => {
  const { state } = input;
  if (input.graceMs <= 0 || input.ownerType !== "human" || input.ownerId === null) {
    return { state: { ...state, absentSince: null }, action: "none" };
  }
  const owner = input.ownerId;
  for (const sessionId of input.viewerSessionIds) {
    if (sessionId === owner) {
      return { state: { viewerSeen: true, absentSince: null }, action: "none" };
    }
  }
  if (!state.viewerSeen || input.helpOpen) {
    return { state: { ...state, absentSince: null }, action: "none" };
  }
  const now = input.now();
  const absentSince = state.absentSince ?? now;
  const next = { ...state, absentSince };
  if (now - absentSince < input.graceMs) return { state: next, action: "none" };
  return { state: next, action: "hand_back", absentMs: now - absentSince };
};

/**
 * The idle close: a browser nobody uses closes itself after `closeAfterTicks`
 * checks in a row that found it idle. Any sign of use resets the count.
 */
export const stepIdleTicks = (input: {
  readonly connected: boolean;
  readonly inUse: boolean;
  readonly ticks: number;
  readonly closeAfterTicks: number;
}): { readonly ticks: number; readonly close: boolean } => {
  if (!input.connected || input.inUse) return { ticks: 0, close: false };
  const ticks = input.ticks + 1;
  return ticks < input.closeAfterTicks ? { ticks, close: false } : { ticks: 0, close: true };
};
