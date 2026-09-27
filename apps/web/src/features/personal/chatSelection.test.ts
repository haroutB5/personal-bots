import type { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  allChatsSelected,
  bulkDeleteConfirmLabel,
  bulkDeleteConfirmMessage,
  bulkResultNotice,
  selectedCountLabel,
  toggleChatSelection,
  visibleSelection,
} from "./chatSelection";

const ids = (...values: string[]) => values as unknown as ThreadId[];

describe("chat selection", () => {
  it("toggles one chat in and out", () => {
    const once = toggleChatSelection(new Set(), "a");
    expect([...once]).toEqual(["a"]);
    expect([...toggleChatSelection(once, "a")]).toEqual([]);
  });

  it("counts only chats still in the section, in list order", () => {
    // "gone" was deleted elsewhere; "b" moved to the other section.
    expect(visibleSelection(new Set(["c", "gone", "a"]), ["a", "c", "d"])).toEqual(["a", "c"]);
  });

  it("reads all selected only when every chat in the section is, and there is one", () => {
    expect(allChatsSelected(new Set(["a", "b"]), ["a", "b"])).toBe(true);
    expect(allChatsSelected(new Set(["a"]), ["a", "b"])).toBe(false);
    // Chats of the other section selected earlier do not count.
    expect(allChatsSelected(new Set(["a", "b", "x"]), ["a", "b"])).toBe(true);
    expect(allChatsSelected(new Set(), [])).toBe(false);
  });

  it("titles the header with the count", () => {
    expect(selectedCountLabel(0)).toBe("Select chats");
    expect(selectedCountLabel(12)).toBe("12 selected");
  });
});

describe("bulk delete confirm", () => {
  it("asks once with the count", () => {
    expect(bulkDeleteConfirmMessage(12, 0)).toBe(
      "Delete 12 chats?\nThey're removed permanently and can't be undone.",
    );
    expect(bulkDeleteConfirmLabel(12)).toBe("Delete 12 chats");
    expect(bulkDeleteConfirmLabel(1)).toBe("Delete 1 chat");
  });

  it("says a working chat's work stops, as a single delete stops it", () => {
    expect(bulkDeleteConfirmMessage(3, 1)).toContain("1 of them is still working; its work stops.");
    expect(bulkDeleteConfirmMessage(3, 2)).toContain(
      "2 of them are still working; their work stops.",
    );
  });
});

describe("bulk result notice", () => {
  it("reports a clean batch", () => {
    expect(bulkResultNotice("delete", { done: ids("a", "b"), failed: [] })).toEqual({
      text: "Deleted 2 chats.",
      failed: false,
    });
    expect(bulkResultNotice("archive", { done: ids("a"), failed: [] }).text).toBe(
      "Archived 1 chat.",
    );
    expect(bulkResultNotice("unarchive", { done: ids("a", "b", "c"), failed: [] }).text).toBe(
      "Unarchived 3 chats.",
    );
  });

  it("reports how many failed, with the first reason", () => {
    const failed = [
      {
        threadId: "m" as ThreadId,
        message:
          "This chat belongs to the group 'Launch crew'. Remove the bot from the group instead.",
      },
      { threadId: "n" as ThreadId, message: "Couldn't delete this chat." },
    ];
    expect(bulkResultNotice("delete", { done: ids("a"), failed })).toEqual({
      text: "Deleted 1 chat. 2 chats couldn't be deleted: This chat belongs to the group 'Launch crew'. Remove the bot from the group instead.",
      failed: true,
    });
    expect(bulkResultNotice("archive", { done: [], failed: failed.slice(1) }).text).toBe(
      "1 chat couldn't be archived: Couldn't delete this chat.",
    );
  });
});
