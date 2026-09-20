import { useEffect, useState } from "react";

export interface AppVersionInfo {
  /** Footer label: "v1.0.5", else the short release sha, else null (dev). */
  readonly label: string | null;
  /**
   * True when the server's stamp names a different entry bundle than the one
   * this page is actually running - i.e. the phone is on a stale cached
   * shell. False when they match or either side is unknown (dev, old stamp).
   */
  readonly updateAvailable: boolean;
}

interface ParsedStamp {
  readonly label: string | null;
  readonly clientEntry: string | null;
}

const SHELL_CACHE_PREFIX = "bots-shell-";

/**
 * Parses the version.txt build.ps1 writes into dist/client (key=value lines).
 * `version` (human semver) wins for the label, else the short release sha.
 * `client` names the build's entry script (e.g. "index-BGoWf-TO.js") so the
 * app can detect that it is running an older bundle than the server serves.
 */
export function parseVersionStamp(text: string): ParsedStamp {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    entries.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const version = entries.get("version");
  const release = entries.get("release");
  const label =
    version !== undefined && version.length > 0
      ? `v${version}`
      : release !== undefined && release.length > 0
        ? release.slice(0, 7)
        : null;
  const clientEntry = entries.get("client");
  return { label, clientEntry: clientEntry && clientEntry.length > 0 ? clientEntry : null };
}

export function parseVersionLabel(text: string): string | null {
  return parseVersionStamp(text).label;
}

/** Entry-script filename of the bundle THIS page is running, or null in dev. */
export function runningClientEntry(doc: Pick<Document, "querySelectorAll">): string | null {
  for (const script of doc.querySelectorAll("script[src]")) {
    const src = script.getAttribute("src") ?? "";
    const match = /\/assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(src);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/** Reads the server's stamp and compares it with the bundle this page runs. */
export async function readAppVersion(
  fetchImpl: typeof fetch,
  doc: Pick<Document, "querySelectorAll">,
): Promise<AppVersionInfo | null> {
  try {
    const response = await fetchImpl("/version.txt", { cache: "no-store" });
    if (!response.ok) return null;
    const stamp = parseVersionStamp(await response.text());
    const running = runningClientEntry(doc);
    return {
      label: stamp.label,
      updateAvailable:
        stamp.clientEntry !== null && running !== null && stamp.clientEntry !== running,
    };
  } catch {
    return null;
  }
}

/**
 * Removes the service worker's saved HTML shell before reloading. iOS can
 * otherwise serve that shell for the first reload while refreshing it in the
 * background, which makes an available update appear to need a second tap.
 *
 * The shell is only cleared when the app has a reason to think it can fetch a
 * new one; see the `isOnline` guard below.
 */
export async function reloadLatestApp(
  cacheStorage: Pick<CacheStorage, "delete" | "keys"> | undefined = typeof caches === "undefined"
    ? undefined
    : caches,
  reload: () => void = () => window.location.reload(),
  isOnline: () => boolean = () =>
    typeof navigator === "undefined" ? true : navigator.onLine !== false,
): Promise<void> {
  // Offline, the saved shell is the only copy of the app: dropping it and
  // reloading gives a blank page instead of the stale-but-working app. The
  // reload still happens, so a queued update lands as soon as the network does.
  if (!isOnline()) {
    reload();
    return;
  }
  try {
    const cacheNames = (await cacheStorage?.keys()) ?? [];
    await Promise.all(
      cacheNames
        .filter((cacheName) => cacheName.startsWith(SHELL_CACHE_PREFIX))
        .map((cacheName) => cacheStorage?.delete(cacheName)),
    );
  } catch {
    // A missing or unavailable Cache Storage API must not block the update.
  }
  reload();
}

export function useAppVersion(): AppVersionInfo {
  const [info, setInfo] = useState<AppVersionInfo>({ label: null, updateAvailable: false });
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void readAppVersion(fetch, document).then((next) => {
        if (!cancelled && next !== null) setInfo(next);
      });
    };
    refresh();
    // A phone keeps this view mounted for days. Checking only on mount means a
    // deployment goes unnoticed until something else remounts the app, so the
    // stamp is re-read whenever the user comes back to the tab.
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return info;
}
