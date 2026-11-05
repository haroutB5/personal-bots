import type { PersonalMemoryEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { memoryEmptyLine, memorySections } from "./memoryScreenModel";

const entry = (id: string): PersonalMemoryEntry =>
  ({
    memoryId: id,
    scope: "shared",
    kind: "note",
    content: `memory ${id}`,
    source: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as unknown as PersonalMemoryEntry;

describe("memoryEmptyLine", () => {
  it("says nothing while rows are visible", () => {
    expect(
      memoryEmptyLine({ search: "", visible: 2, totals: { rules: 2, notes: 0, summaries: 0 } }),
    ).toBeNull();
  });

  it("names a search with no matches", () => {
    expect(
      memoryEmptyLine({
        search: "matchday",
        visible: 0,
        totals: { rules: 1, notes: 0, summaries: 0 },
      }),
    ).toBe("No memory matches that search.");
  });

  it("invites the first memory when nothing is saved", () => {
    expect(
      memoryEmptyLine({ search: "", visible: 0, totals: { rules: 0, notes: 0, summaries: 0 } }),
    ).toBe('Nothing saved yet. Ask a bot to "remember" something.');
  });

  it("keeps the list blank when a loaded total is non-zero but this page is empty", () => {
    expect(
      memoryEmptyLine({ search: "", visible: 0, totals: { rules: 0, notes: 5, summaries: 0 } }),
    ).toBeNull();
  });
});

describe("memorySections", () => {
  it("heads each section with its server total and offers Show more only when a page is short", () => {
    const sections = memorySections({
      rules: [entry("r1")],
      ruleTotal: 3,
      notes: [entry("n1"), entry("n2")],
      noteTotal: 2,
      summaries: [],
      summaryTotal: 0,
    });
    expect(sections.map((section) => section.heading)).toEqual([
      "Rules · 3",
      "Notes · 2",
      "Task summaries · 0",
    ]);
    expect(sections.map((section) => section.showMore)).toEqual([true, false, false]);
  });
});
