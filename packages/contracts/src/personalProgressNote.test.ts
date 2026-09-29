import { describe, expect, it } from "vite-plus/test";

import {
  PERSONAL_PROGRESS_NOTE_MAX_CHARS,
  pickProgressNote,
  progressNoteFromReasoning,
  progressNoteFromToolTitle,
} from "./personalProgressNote.ts";

describe("progressNoteFromReasoning", () => {
  it("uses the title line of a thinking summary, without the markdown", () => {
    expect(
      progressNoteFromReasoning(
        "**Reading the failing test**\n\nI need to look at how the budget is computed.",
      ),
    ).toBe("Reading the failing test");
  });

  it("takes the latest title of a message that has run on for the whole turn", () => {
    expect(
      progressNoteFromReasoning(
        "**Reading the failing test**\n\nI need to look at the budget.**Planning the fix**\n\nOne row per thread is enough.",
      ),
    ).toBe("Planning the fix");
    // A bold span inside a sentence is not a title.
    expect(
      progressNoteFromReasoning("**Reading the test**\n\nLook at **budget.ts** first, then run it"),
    ).toBe("Reading the test");
  });

  it("uses the last non-empty line of raw thinking, skipping blank lines and fences", () => {
    expect(
      progressNoteFromReasoning("Let me start\n\n```\n---\nChecking the   migration\n\n```\n"),
    ).toBe("Checking the migration");
  });

  it("clips to about 120 characters with an ellipsis", () => {
    const note = progressNoteFromReasoning("word ".repeat(80));
    expect(note).not.toBeNull();
    expect(note!.length).toBeLessThanOrEqual(PERSONAL_PROGRESS_NOTE_MAX_CHARS);
    expect(note!.endsWith("…")).toBe(true);
    expect(note!.includes("\n")).toBe(false);
  });

  it("is null for nothing readable", () => {
    expect(progressNoteFromReasoning("")).toBeNull();
    expect(progressNoteFromReasoning("   \n ```\n")).toBeNull();
  });

  it.each([
    ["Calling the API with sk-abcdefghijklmnopqrstuvwx now", "sk-abcdefghijklmnopqrstuvwx"],
    ["Using ghp_abcdefghijklmnopqrstuvwxyz123456 to push", "ghp_abcdefghijklmnopqrstuvwxyz123456"],
    ["Sent Authorization: Bearer abcdef0123456789abcdef", "abcdef0123456789abcdef"],
    ["The password=hunter2hunter2 is set", "hunter2hunter2"],
    ["PB_SECRET_GITHUB_TOKEN=abc123 in the env", "abc123"],
    [
      "Decoding aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgb3BhcXVlIHJ1biBvZiBiYXNlNjQ= later",
      "aGVsbG8gd29ybGQ",
    ],
  ])("blanks a secret-looking run: %s", (text, secret) => {
    const note = progressNoteFromReasoning(text);
    expect(note).not.toBeNull();
    expect(note).toContain("[hidden]");
    expect(note).not.toContain(secret);
  });

  it("does not show a line that is only a secret", () => {
    expect(progressNoteFromReasoning("token: abcdefghijklmnop")).toBeNull();
  });
});

describe("progressNoteFromToolTitle", () => {
  it("keeps a plain title", () => {
    expect(progressNoteFromToolTitle("Running tests")).toBe("Running tests");
  });
});

describe("pickProgressNote", () => {
  const reasoning = { text: "**Planning the fix**", at: "2026-09-29T10:00:00.000Z" };

  it("prefers the newest of the two", () => {
    expect(
      pickProgressNote({
        reasoning,
        tool: { text: "Running tests", at: "2026-09-29T10:00:05.000Z" },
      }),
    ).toBe("Running tests");
    expect(
      pickProgressNote({
        reasoning,
        tool: { text: "Running tests", at: "2026-09-29T09:59:00.000Z" },
      }),
    ).toBe("Planning the fix");
  });

  it("takes reasoning on a tie and falls back to the tool title alone", () => {
    expect(pickProgressNote({ reasoning, tool: { text: "Running tests", at: reasoning.at } })).toBe(
      "Planning the fix",
    );
    expect(pickProgressNote({ tool: { text: "Running tests", at: reasoning.at } })).toBe(
      "Running tests",
    );
    expect(pickProgressNote({ reasoning: { text: "```", at: reasoning.at } })).toBeNull();
    expect(pickProgressNote({})).toBeNull();
  });
});
