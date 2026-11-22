import { describe, expect, it } from "vite-plus/test";

import { MAX_NOTE_LINES, sanitizeUpdateNotes, updateNoteItems } from "./updateNotes";

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

describe("updateNoteItems", () => {
  it("makes one item per line, dropping blank lines and typed markers", () => {
    expect(
      updateNoteItems(
        "1. Server stats replace the gaming PC\n\n- Bots working has a setting\n• What's new is a list\n3) Fixed the row",
      ),
    ).toEqual([
      "Server stats replace the gaming PC",
      "Bots working has a setting",
      "What's new is a list",
      "Fixed the row",
    ]);
  });

  it("splits an older single-paragraph note into its sentences", () => {
    expect(
      updateNoteItems(
        "Reordering pinned bots is now smooth. The held bot lifts! Version 1.67.47 is out.",
      ),
    ).toEqual([
      "Reordering pinned bots is now smooth.",
      "The held bot lifts!",
      "Version 1.67.47 is out.",
    ]);
  });

  it("keeps a one-sentence note whole, even with a version number inside", () => {
    expect(updateNoteItems("Faster start on 1.67.48.")).toEqual(["Faster start on 1.67.48."]);
  });

  it("caps the items and is empty for no notes", () => {
    const many = Array.from({ length: 12 }, (_, index) => `item ${String(index)}`).join("\n");
    expect(updateNoteItems(many)).toHaveLength(MAX_NOTE_LINES);
    expect(updateNoteItems(null)).toEqual([]);
    expect(updateNoteItems(" \n ")).toEqual([]);
  });
});
