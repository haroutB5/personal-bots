import { useEffect, useState } from "react";

/**
 * Short build label for the Chats screen footer, e.g. "7ae8f86 · 13 Sep".
 * Parsed from the release VERSION file build.ps1 copies into dist/client
 * (key=value lines). Null when the file is missing or unparsable (dev serves
 * no /VERSION), in which case the footer is simply omitted.
 */
export function parseVersionLabel(text: string): string | null {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    entries.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const release = entries.get("release");
  if (release === undefined || release.length === 0) return null;
  const short = release.slice(0, 7);
  const builtAt = entries.get("builtAt");
  const built = builtAt === undefined ? null : new Date(builtAt);
  if (built === null || Number.isNaN(built.getTime())) return short;
  const day = built.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${short} · ${day}`;
}

export function useAppVersion(): string | null {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch("/VERSION", { cache: "no-store" })
      .then((response) => (response.ok ? response.text() : null))
      .then((text) => {
        if (!cancelled && text !== null) setLabel(parseVersionLabel(text));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return label;
}
