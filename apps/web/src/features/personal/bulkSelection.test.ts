import { describe, expect, it } from "vite-plus/test";

import {
  allSelected,
  bulkDeleteConfirmLabel,
  bulkResultNotice,
  chunkIds,
  countOf,
  DELETE_VERB,
  selectedCountLabel,
  toggleAllSelection,
  toggleSelection,
  visibleSelection,
} from "./bulkSelection";

const FILE = { one: "file", many: "files" };
const MEMORY = { one: "memory", many: "memories" };

describe("selection", () => {
  it("toggles one row in and out", () => {
    const once = toggleSelection(new Set(), "a");
    expect([...once]).toEqual(["a"]);
    expect([...toggleSelection(once, "a")]).toEqual([]);
  });

  it("counts only rows still shown, in list order", () => {
    // "gone" was deleted elsewhere; "b" is hidden by the search.
    expect(visibleSelection(new Set(["c", "gone", "a", "b"]), ["a", "c", "d"])).toEqual(["a", "c"]);
  });

  it("reads all selected only when every shown row is, and there is one", () => {
    expect(allSelected(new Set(["a", "b"]), ["a", "b"])).toBe(true);
    expect(allSelected(new Set(["a"]), ["a", "b"])).toBe(false);
    expect(allSelected(new Set(["a", "b", "x"]), ["a", "b"])).toBe(true);
    expect(allSelected(new Set(), [])).toBe(false);
  });

  it("selects every shown row, then deselects only those", () => {
    const all = toggleAllSelection(new Set(["x"]), ["a", "b"]);
    expect([...all].toSorted()).toEqual(["a", "b", "x"]);
    // A group's Select all leaves the other groups' picks alone.
    expect([...toggleAllSelection(all, ["a", "b"])]).toEqual(["x"]);
    // Partly selected: Select all fills the rest.
    expect([...toggleAllSelection(new Set(["a"]), ["a", "b"])].toSorted()).toEqual(["a", "b"]);
  });
});

describe("labels", () => {
  it("counts in words", () => {
    expect(countOf(1, FILE)).toBe("1 file");
    expect(countOf(12, MEMORY)).toBe("12 memories");
  });

  it("titles the header with the count", () => {
    expect(selectedCountLabel(0, FILE)).toBe("Select files");
    expect(selectedCountLabel(0, MEMORY)).toBe("Select memories");
    expect(selectedCountLabel(3, FILE)).toBe("3 selected");
  });

  it("names the count on the confirm button", () => {
    expect(bulkDeleteConfirmLabel(12, FILE)).toBe("Delete 12 files");
    expect(bulkDeleteConfirmLabel(1, MEMORY)).toBe("Delete 1 memory");
  });
});

describe("bulk result notice", () => {
  it("reports a clean batch", () => {
    expect(bulkResultNotice(DELETE_VERB, FILE, 12, [])).toEqual({
      text: "Deleted 12 files.",
      failed: false,
    });
  });

  it("reports how many failed, with the first reason", () => {
    expect(
      bulkResultNotice(DELETE_VERB, FILE, 10, ["Couldn't delete this file.", "Something else."]),
    ).toEqual({
      text: "Deleted 10 files. 2 files couldn't be deleted: Couldn't delete this file.",
      failed: true,
    });
    expect(bulkResultNotice(DELETE_VERB, MEMORY, 0, [""]).text).toBe(
      "1 memory couldn't be deleted.",
    );
  });
});

describe("chunkIds", () => {
  it("splits a large selection into server-sized requests", () => {
    expect(chunkIds(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(chunkIds([], 500)).toEqual([]);
  });
});
