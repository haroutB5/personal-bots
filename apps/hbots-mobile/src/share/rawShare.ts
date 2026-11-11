import type { RawShare, RawShareItem } from "./pickerModel";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Reads the payload the share activity wrote. Anything malformed is no share. */
export function parseRawShare(json: string): RawShare | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) return null;
  const items: RawShareItem[] = [];
  for (const entry of parsed.items) {
    if (!isRecord(entry)) return null;
    if (entry.kind === "text" && typeof entry.text === "string") {
      items.push({ kind: "text", text: entry.text });
    } else if (
      entry.kind === "stream" &&
      typeof entry.name === "string" &&
      typeof entry.mime === "string" &&
      typeof entry.bytes === "number" &&
      (typeof entry.uri === "string" || entry.uri === null)
    ) {
      items.push({
        kind: "stream",
        uri: entry.uri,
        name: entry.name,
        mime: entry.mime,
        bytes: entry.bytes,
      });
    } else {
      return null;
    }
  }
  const count = typeof parsed.count === "number" ? parsed.count : items.length;
  return { ask: parsed.ask === true, count, items };
}
