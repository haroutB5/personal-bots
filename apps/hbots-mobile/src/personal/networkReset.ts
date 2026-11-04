import { requireOptionalNativeModule } from "expo";

interface NetworkResetModule {
  readonly reset: () => Promise<boolean>;
  readonly isOnline: () => boolean;
  readonly canReachNetwork: () => Promise<boolean>;
  readonly relaunch: () => Promise<boolean>;
}

const native = requireOptionalNativeModule<NetworkResetModule>("HbotsNetwork");

/**
 * Drops the shared OkHttp pool. A dropped network can leave sockets bound to
 * the old route in it; new attempts then wait on them until their timeout.
 */
export async function resetNetworkClient(): Promise<void> {
  if (native === null) return;
  try {
    await native.reset();
  } catch {
    // A missing or failed reset only means the next attempt keeps the old pool.
  }
}

/**
 * The phone itself has working internet, whatever this app's sockets do. A
 * fresh OkHttp client proves it without depending on Android's capability
 * flags, which can stay stale after a flap.
 */
export async function phoneHasInternet(): Promise<boolean> {
  if (native === null) return false;
  try {
    if (native.isOnline()) return true;
    return await native.canReachNetwork();
  } catch {
    return false;
  }
}

/** Rebuilds the app process. The saved session and outbox survive the restart. */
export async function relaunchApp(): Promise<void> {
  if (native === null) return;
  try {
    await native.relaunch();
  } catch {
    // The next attempt keeps trying the current process.
  }
}
