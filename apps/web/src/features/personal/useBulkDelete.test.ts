import { describe, expect, it } from "vite-plus/test";

import { bulkDeleteFilesConfirmMessage, bulkDeleteMemoriesConfirmMessage } from "./useBulkDelete";

describe("bulk delete confirm", () => {
  it("names the count of files", () => {
    expect(bulkDeleteFilesConfirmMessage(12)).toBe(
      "Delete 12 files?\nThey'll disappear from your chats and can't be undone.",
    );
    expect(bulkDeleteFilesConfirmMessage(1).split("\n")[0]).toBe("Delete 1 file?");
  });

  it("names the count of memories and says what deleting them does", () => {
    expect(bulkDeleteMemoriesConfirmMessage(5)).toBe(
      "Delete 5 memories?\nBots stop receiving them. Chats where they were mentioned still contain the text.",
    );
    expect(bulkDeleteMemoriesConfirmMessage(1)).toBe(
      "Delete 1 memory?\nBots stop receiving it. Chats where it was mentioned still contain the text.",
    );
  });
});
