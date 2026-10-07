import type { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  allChatsSelected,
  bulkDeleteConfirmLabel,
  bulkDeleteConfirmMessage,
  bulkResultNotice,
  isChatStateAction,
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

describe("bulk pin, snooze and mark unread", () => {
  it("tells state actions from archive and delete", () => {
    for (const action of ["pin", "unpin", "snooze", "wake", "markUnread"] as const) {
      expect(isChatStateAction(action)).toBe(true);
    }
    for (const action of ["archive", "unarchive", "delete"] as const) {
      expect(isChatStateAction(action)).toBe(false);
    }
  });

  it("words each result in one plain line", () => {
    const done = { done: ids("a", "b"), failed: [] };
    expect(bulkResultNotice("pin", done).text).toBe("Pinned 2 chats.");
    expect(bulkResultNotice("unpin", { done: ids("a"), failed: [] }).text).toBe("Unpinned 1 chat.");
    expect(bulkResultNotice("snooze", done).text).toBe("Snoozed 2 chats.");
    expect(bulkResultNotice("wake", { done: ids("a"), failed: [] }).text).toBe("Woke 1 chat.");
    expect(bulkResultNotice("markUnread", done).text).toBe("2 chats marked unread.");
  });

  it("names the refused chats and why", () => {
    const notice = bulkResultNotice("markUnread", {
      done: ids("a"),
      failed: [{ threadId: "b" as never, message: "That chat is archived." }],
    });
    expect(notice).toEqual({
      text: "1 chat marked unread. 1 chat couldn't be marked unread: That chat is archived.",
      failed: true,
    });
    expect(
      bulkResultNotice("snooze", {
        done: [],
        failed: [{ threadId: "b" as never, message: "A chat can be snoozed for at most a year." }],
      }).text,
    ).toBe("1 chat couldn't be snoozed: A chat can be snoozed for at most a year.");
  });
});

describe("bulk unarchive under a new name", () => {
  it("says which chat came back under a number", () => {
    expect(
      bulkResultNotice("unarchive", {
        done: ids("a"),
        failed: [],
        renamed: [{ threadId: "a" as ThreadId, from: "Main", title: "Main 3" }],
      }).text,
    ).toBe("Unarchived 1 chat. “Main” is in use now, so this chat is now “Main 3”.");
  });

  it("counts them when several came back under a number", () => {
    expect(
      bulkResultNotice("unarchive", {
        done: ids("a", "b", "c"),
        failed: [],
        renamed: [
          { threadId: "a" as ThreadId, from: "Main", title: "Main 2" },
          { threadId: "b" as ThreadId, from: "Plan", title: "Plan 2" },
        ],
      }).text,
    ).toBe("Unarchived 3 chats. 2 chats got a number after their name because it is in use now.");
  });

  it("adds nothing for other actions or when no chat was renamed", () => {
    expect(bulkResultNotice("unarchive", { done: ids("a"), failed: [] }).text).toBe(
      "Unarchived 1 chat.",
    );
    expect(
      bulkResultNotice("archive", {
        done: ids("a"),
        failed: [],
        renamed: [{ threadId: "a" as ThreadId, from: "Main", title: "Main 3" }],
      }).text,
    ).toBe("Archived 1 chat.");
  });
});
