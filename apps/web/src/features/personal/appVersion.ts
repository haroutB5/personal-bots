import { useEffect, useState } from "react";

/**
 * Build label for the Chats screen footer: the human version when the stamp
 * carries one ("v1.0.5"), else the short release sha ("7ae8f86"). Parsed from
 * the version.txt build.ps1 writes into dist/client (key=value lines). Null
 * when the file is missing or unparsable (dev serves no /version.txt), in
 * which case the footer is simply omitted.
 */
export function parseVersionLabel(text: string): string | null {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    entries.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const version = entries.get("version");
  if (version !== undefined && version.length > 0) return `v${version}`;
  const release = entries.get("release");
  if (release === undefined || release.length === 0) return null;
  return release.slice(0, 7);
}

export function useAppVersion(): string | null {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch("/version.txt", { cache: "no-store" })
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
