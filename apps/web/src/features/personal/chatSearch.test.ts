import { describe, expect, it } from "vite-plus/test";

import { canSearchMessages, MESSAGE_SEARCH_DEBOUNCE_MS, splitSnippet } from "./chatSearch";

describe("canSearchMessages", () => {
  it("needs two characters after trimming and at most a hundred", () => {
    expect(canSearchMessages("")).toBe(false);
    expect(canSearchMessages("a")).toBe(false);
    expect(canSearchMessages("  a  ")).toBe(false);
    expect(canSearchMessages("ab")).toBe(true);
    expect(canSearchMessages("  ab ")).toBe(true);
    expect(canSearchMessages("x".repeat(100))).toBe(true);
    expect(canSearchMessages("x".repeat(101))).toBe(false);
  });

  it("debounces for 300 ms", () => {
    expect(MESSAGE_SEARCH_DEBOUNCE_MS).toBe(300);
  });
});

describe("splitSnippet", () => {
  it("marks every occurrence, ignoring case, and keeps the original text", () => {
    expect(splitSnippet("Invoice for the invoice run", " INVOICE ")).toEqual([
      { text: "Invoice", match: true },
      { text: " for the ", match: false },
      { text: "invoice", match: true },
      { text: " run", match: false },
    ]);
  });

  it("returns one plain segment when nothing matches", () => {
    expect(splitSnippet("nothing here", "zz")).toEqual([{ text: "nothing here", match: false }]);
  });

  it("treats the query as plain text, not a pattern", () => {
    expect(splitSnippet("a.b and axb", "a.b")).toEqual([
      { text: "a.b", match: true },
      { text: " and axb", match: false },
    ]);
    expect(splitSnippet("cost (usd) now", "(usd)")).toEqual([
      { text: "cost ", match: false },
      { text: "(usd)", match: true },
      { text: " now", match: false },
    ]);
  });

  it("keeps ellipses and handles matches at the edges", () => {
    expect(splitSnippet("…ab", "ab")).toEqual([
      { text: "…", match: false },
      { text: "ab", match: true },
    ]);
    expect(splitSnippet("abab", "ab")).toEqual([
      { text: "ab", match: true },
      { text: "ab", match: true },
    ]);
  });

  it("stays aligned with letters whose lower case is longer", () => {
    expect(splitSnippet("İ then ok", "ok")).toEqual([
      { text: "İ then ", match: false },
      { text: "ok", match: true },
    ]);
  });

  it("handles empty input", () => {
    expect(splitSnippet("", "ab")).toEqual([]);
    expect(splitSnippet("abc", "  ")).toEqual([{ text: "abc", match: false }]);
  });
});
