export const MAX_NOTE_LINES = 8;
export const MAX_NOTE_CHARS = 500;

const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
// eslint-disable-next-line no-control-regex -- stripping control characters is the job
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
