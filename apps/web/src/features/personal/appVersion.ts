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

export function useAppVersion(): AppVersionInfo {
  const [info, setInfo] = useState<AppVersionInfo>({ label: null, updateAvailable: false });
  useEffect(() => {
    let cancelled = false;
    void fetch("/version.txt", { cache: "no-store" })
      .then((response) => (response.ok ? response.text() : null))
      .then((text) => {
        if (cancelled || text === null) return;
        const stamp = parseVersionStamp(text);
        const running = runningClientEntry(document);
        setInfo({
          label: stamp.label,
          updateAvailable:
            stamp.clientEntry !== null && running !== null && stamp.clientEntry !== running,
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return info;
}
