import { requireOptionalNativeModule } from "expo";

interface NetworkResetModule {
  readonly reset: () => Promise<boolean>;
}

const native = requireOptionalNativeModule<NetworkResetModule>("HbotsNetwork");

/**
 * Drops the shared OkHttp pool. A dropped network can leave sockets bound to
 * the old route in it; new attempts then wait on them until their timeout.
 * Resetting the pool is what a fresh app process does, without the restart.
 */
export async function resetNetworkClient(): Promise<void> {
  if (native === null) return;
  try {
    await native.reset();
  } catch {
    // A missing or failed reset only means the next attempt keeps the old pool.
  }
}
