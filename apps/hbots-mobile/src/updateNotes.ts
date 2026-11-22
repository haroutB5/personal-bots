export const MAX_NOTE_LINES = 8;
export const MAX_NOTE_CHARS = 500;

const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;

/** Release notes are untrusted text and render only through React Native Text. */
export function sanitizeUpdateNotes(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw.length === 0) {
    return [];
  }
  const text = raw
    .replace(/\r\n?/gu, "\n")
    .replace(/\u2028|\u2029/gu, "\n")
    .replace(BIDI, "")
    .replace(CONTROL, "")
    .slice(0, MAX_NOTE_CHARS);
  return text
    .split("\n")
    .slice(0, MAX_NOTE_LINES)
    .map((line) => line.trimEnd());
}

const MARKER = /^\s*(?:\d{1,2}[.)]|[-*\u2022])\s+/u;
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z0-9"'(])/u;

/**
 * What's new as a list of features, for numbering on screen. Notes are one item per line; a
 * marker someone typed ("1.", "-", "•") is dropped so the list is not numbered twice. An older
 * release's single-paragraph note is split into its sentences, one item each.
 */
export function updateNoteItems(raw: string | null | undefined): string[] {
  const lines = sanitizeUpdateNotes(raw)
    .map((line) => line.replace(MARKER, "").trim())
    .filter((line) => line.length > 0);
  const items =
    lines.length === 1 ? (lines[0] ?? "").split(SENTENCE_BREAK).map((item) => item.trim()) : lines;
  return items.filter((item) => item.length > 0).slice(0, MAX_NOTE_LINES);
}
