import { bootVersionText, parseVersionStamp, runningClientEntry } from "./appVersion";
import { perfOptimizationOn } from "./perfFlags";

/**
 * First open after a release.
 *
 * The service worker answers app navigations with the saved shell, so the
 * first launch after a restart boots the previous release's client. That
 * client then loads for many seconds against a server that has moved on (21 s
 * measured on the iPhone) before anything noticed. Instead, the boot reads
 * /version.txt straight away and, when the server names a different entry
 * bundle than the one running, reloads once to the new release before the
 * user waits for the old one.
 *
 * Loop guard: the entry bundle a reload was made for is kept in
 * sessionStorage. A second mismatch against the same target does not reload
 * again (for example when the shell keeps coming back stale), and a boot that
 * matches the server clears it.
 */
const GUARD_KEY = "bots:stale-reload";
/** Must match SHELL_KEY / CACHE_PREFIX in public/sw.js. */
const SHELL_KEY = "/__bots-shell__";
const SHELL_CACHE_PREFIX = "bots-shell-";

export type StaleReloadDecision =
  | { readonly reload: true; readonly target: string }
  | {
      readonly reload: false;
      readonly reason: "off" | "unknown" | "current" | "already-reloaded" | "no-storage";
    };

export function decideStaleReload(input: {
  readonly enabled: boolean;
  readonly running: string | null;
  readonly served: string | null;
  readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}): StaleReloadDecision {
  if (!input.enabled) return { reload: false, reason: "off" };
  if (input.running === null || input.served === null) return { reload: false, reason: "unknown" };
  if (input.storage === null) return { reload: false, reason: "no-storage" };
  try {
    if (input.running === input.served) {
      input.storage.removeItem(GUARD_KEY);
      return { reload: false, reason: "current" };
    }
    if (input.storage.getItem(GUARD_KEY) === input.served) {
      return { reload: false, reason: "already-reloaded" };
    }
    input.storage.setItem(GUARD_KEY, input.served);
  } catch {
    // Without storage the guard cannot survive the reload; never risk a loop.
    return { reload: false, reason: "no-storage" };
  }
  return { reload: true, target: input.served };
}

/**
 * Drops only the saved HTML shell (not the cached chunks), so the reload is
 * answered by the network even where the browser does not flag it as a reload
 * navigation. Best-effort: the reload happens regardless.
 */
export async function dropSavedShell(
  cacheStorage: Pick<CacheStorage, "keys" | "open"> | undefined,
): Promise<void> {
  if (cacheStorage === undefined) return;
  try {
    const names = (await cacheStorage.keys()).filter((name) => name.startsWith(SHELL_CACHE_PREFIX));
    await Promise.all(names.map(async (name) => (await cacheStorage.open(name)).delete(SHELL_KEY)));
  } catch {
    // Storage unavailable: the reload navigation still asks the network.
  }
}

export interface StaleReleaseBoot {
  readonly doc: Pick<Document, "querySelectorAll">;
  readonly fetch: typeof fetch;
  readonly storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  readonly caches: Pick<CacheStorage, "keys" | "open"> | undefined;
  readonly reload: () => void;
}

function browserBoot(): StaleReleaseBoot {
  return {
    doc: document,
    fetch: (input, init) => fetch(input, init),
    storage: () => {
      try {
        return window.sessionStorage;
      } catch {
        return null;
      }
    },
    caches: typeof caches === "undefined" ? undefined : caches,
    reload: () => window.location.reload(),
  };
}

/**
 * Starts the boot check. `onReload` runs just before the page reloads, so the
 * boot can skip painting the old client. Resolves to the decision (for tests
 * and diagnostics).
 */
export async function checkStaleReleaseAtBoot(
  onReload: () => void,
  boot: StaleReleaseBoot = browserBoot(),
): Promise<StaleReloadDecision> {
  const enabled = perfOptimizationOn("stale-reload");
  // Dev and Electron have no entry stamp; skip the request there.
  const running = runningClientEntry(boot.doc);
  if (!enabled || running === null) {
    return { reload: false, reason: enabled ? "unknown" : "off" };
  }
  const text = await bootVersionText(boot.fetch);
  const served = text === null ? null : parseVersionStamp(text).clientEntry;
  const decision = decideStaleReload({ enabled, running, served, storage: boot.storage() });
  if (decision.reload) {
    onReload();
    await dropSavedShell(boot.caches);
    boot.reload();
  }
  return decision;
}
