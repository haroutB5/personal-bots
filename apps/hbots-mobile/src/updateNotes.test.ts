import { describe, expect, it } from "vite-plus/test";

import { MAX_NOTE_LINES, sanitizeUpdateNotes } from "./updateNotes";

describe("sanitizeUpdateNotes", () => {
  it("keeps HTML and javascript links as literal text", () => {
    const notes = sanitizeUpdateNotes('<b>Faster</b> <a href="javascript:alert(1)">open</a>');
    expect(notes).toEqual(['<b>Faster</b> <a href="javascript:alert(1)">open</a>']);
  });

  it("strips bidi overrides and control characters but keeps newlines", () => {
    const notes = sanitizeUpdateNotes("one\u202Eevil\u0007\ntwo\u2066three\u2069");
    expect(notes).toEqual(["oneevil", "twothree"]);
  });

  it("normalizes CRLF and caps the line count", () => {
    const lines = Array.from({ length: MAX_NOTE_LINES + 4 }, (_, index) => `line ${String(index)}`);
    const notes = sanitizeUpdateNotes(lines.join("\r\n"));
    expect(notes).toHaveLength(MAX_NOTE_LINES);
    expect(notes[0]).toBe("line 0");
  });

  it("returns no lines for an empty note", () => {
    expect(sanitizeUpdateNotes(null)).toEqual([]);
    expect(sanitizeUpdateNotes("")).toEqual([]);
  });
});
