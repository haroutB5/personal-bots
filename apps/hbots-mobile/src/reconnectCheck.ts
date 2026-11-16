import type { UpdateStateKind } from "./updater";

/**
 * Starts an update check when the connection comes back, at most once a minute. Opening the app
 * counts as a check made then, so the first connect a moment after the launch check adds none.
 * After a download fails, a reconnect waits longer before it checks again, so a network that keeps
 * dropping does not start a 55 MB download every minute.
 */
export const RECONNECT_CHECK_MIN_GAP_MS = 60_000;

/** The wait after the 1st, the 2nd, and the 3rd and later failed download of one release. */
export const DOWNLOAD_FAILURE_WAIT_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

export interface ConnectionSource {
  /** Calls the listener with the current state and again on each change. */
  readonly subscribe: (onChange: (connected: boolean) => void) => () => void;
}

/** The part of the updater state this reads. An `UpdateSnapshot` fits. */
export interface UpdaterView {
  readonly state: UpdateStateKind;
  readonly target: { readonly version: string } | null;
  readonly rejected: string | null;
}

export interface UpdaterSource {
  /** Calls the listener on each change of the updater state. */
  readonly subscribe: (onChange: (view: UpdaterView) => void) => () => void;
}

export interface ReconnectCheckOptions {
  readonly connection: ConnectionSource;
  readonly updates: UpdaterSource;
  /** Starts the update check. A failure is its own to handle. */
  readonly check: () => void;
  /** The kill switch, read at each reconnect. */
  readonly isOn: () => boolean;
  readonly now?: () => number;
}

export function startReconnectCheck(options: ReconnectCheckOptions): () => void {
  const now = options.now ?? Date.now;
  let wasConnected = false;
  let lastCheckAt = now();

  let failures = 0;
  let failedVersion: string | null = null;
  let failedAt = 0;
  let previous: UpdaterView | null = null;
  const stopUpdates = options.updates.subscribe((view) => {
    const before = previous;
    previous = view;
    if (view.target !== null && view.target.version !== failedVersion) {
      failures = 0;
    }
    if (view.state === "ready" || view.state === "installing" || view.state === "needsTap") {
      failures = 0;
      return;
    }
    // A download that stops with no release held back is a failed one. A rejected one is not:
    // the phone does not fetch the same rejected file again.
    if (before?.state === "downloading" && view.state === "idle" && view.rejected === null) {
      failures += 1;
      failedVersion = before.target?.version ?? null;
      failedAt = now();
    }
  });

  const stopConnection = options.connection.subscribe((connected) => {
    const returned = connected && !wasConnected;
    wasConnected = connected;
    if (!returned || !options.isOn()) {
      return;
    }
    const at = now();
    if (at - lastCheckAt < RECONNECT_CHECK_MIN_GAP_MS) {
      return;
    }
    if (failures > 0) {
      const wait = DOWNLOAD_FAILURE_WAIT_MS[Math.min(failures, DOWNLOAD_FAILURE_WAIT_MS.length) - 1]!;
      if (at - failedAt < wait) {
        return;
      }
    }
    lastCheckAt = at;
    options.check();
  });

  return () => {
    stopConnection();
    stopUpdates();
  };
}
