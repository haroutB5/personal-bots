import { requireOptionalNativeModule } from "expo";

interface NetworkResetModule {
  readonly reset: () => Promise<boolean>;
  readonly isOnline: () => boolean;
  readonly canReachNetwork: () => Promise<boolean>;
}

const native = requireOptionalNativeModule<NetworkResetModule>("HbotsNetwork");

/** Long enough for a healthy round trip, short enough for the recovery budget. */
const PROBE_TIMEOUT_MS = 3_000;

/** Long enough for an OkHttp eviction, short enough that a stuck reset cannot hold recovery. */
const RESET_TIMEOUT_MS = 2_000;

/**
 * Drops the shared OkHttp pool. A dropped network can leave sockets bound to
 * the old route in it; new attempts then wait on them until their timeout.
 * A reset that never returns must not become the thing that keeps the app
 * offline, so the loop stops waiting for it after the timeout and tries the
 * connection anyway.
 */
export async function resetNetworkClient(): Promise<void> {
  if (native === null) return;
  try {
    await Promise.race([
      native.reset(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, RESET_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // A missing or failed reset only means the next attempt keeps the old pool.
  }
}

/**
 * A plain fetch from JS, to an origin the app does not otherwise use. It proves
 * the process can open a new connection whatever state its existing sockets are
 * in, which is exactly what the native checks fail to answer when they throw.
 */
async function jsProbe(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
      signal: controller.signal,
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The phone itself has working internet, whatever this app's sockets do. Each
 * check is tried in turn because every one of them can fail for its own reason:
 * the capability read needs a permission the manifest may not carry, and the
 * native probe is one more thing that can reject across the module bridge.
 */
export async function phoneHasInternet(): Promise<boolean> {
  if (native !== null) {
    try {
      if (native.isOnline()) return true;
    } catch {
      // Fall through: the capability read is the check most likely to reject.
    }
    try {
      if (await native.canReachNetwork()) return true;
    } catch {
      // Fall through to the JavaScript probe.
    }
  }
  return jsProbe();
}
