/**
 * Starts an update check when the connection comes back, at most once a minute. Opening the app
 * counts as a check made then, so the first connect a moment after the launch check adds none.
 */
export const RECONNECT_CHECK_MIN_GAP_MS = 60_000;

export interface ConnectionSource {
  /** Calls the listener with the current state and again on each change. */
  readonly subscribe: (onChange: (connected: boolean) => void) => () => void;
}

export interface ReconnectCheckOptions {
  readonly connection: ConnectionSource;
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
  return options.connection.subscribe((connected) => {
    const returned = connected && !wasConnected;
    wasConnected = connected;
    if (!returned || !options.isOn()) {
      return;
    }
    const at = now();
    if (at - lastCheckAt < RECONNECT_CHECK_MIN_GAP_MS) {
      return;
    }
    lastCheckAt = at;
    options.check();
  });
}
