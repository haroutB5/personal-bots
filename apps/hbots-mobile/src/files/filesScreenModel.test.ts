import type { BotFileGroup } from "@hbots/personal-client/files/filesModel";
import type { PersonalFile } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { chosenFiles, fileRowAction, filesScreenState, shownFileIds } from "./filesScreenModel";

function file(fileId: string, botId: string): PersonalFile {
  return { fileId, botId, name: `${fileId}.png` } as PersonalFile;
}

const groups: ReadonlyArray<BotFileGroup> = [
  { bot: { botId: "a" } as BotFileGroup["bot"], files: [file("1", "a"), file("2", "a")] },
  { bot: { botId: "b" } as BotFileGroup["bot"], files: [file("3", "b")] },
];

describe("filesScreenState", () => {
  it("waits for both lists before drawing rows", () => {
    expect(
      filesScreenState({ filesLoaded: true, botsLoaded: false, error: null, fileCount: 2 }),
    ).toEqual({ kind: "loading" });
  });

  it("shows the error before either list's state", () => {
    expect(
      filesScreenState({
        filesLoaded: false,
        botsLoaded: false,
        error: "Can't reach your laptop.",
        fileCount: 0,
      }),
    ).toEqual({ kind: "error", message: "Can't reach your laptop." });
  });

  it("tells empty apart from ready, so the empty copy only shows on a real empty tab", () => {
    expect(
      filesScreenState({ filesLoaded: true, botsLoaded: true, error: null, fileCount: 0 }),
    ).toEqual({ kind: "empty" });
    expect(
      filesScreenState({ filesLoaded: true, botsLoaded: true, error: null, fileCount: 3 }),
    ).toEqual({ kind: "ready" });
  });
});

describe("selection over the visible groups", () => {
  it("lists every file on screen in order", () => {
    expect(shownFileIds(groups)).toEqual(["1", "2", "3"]);
  });

  it("returns only picked files still on screen", () => {
    expect(chosenFiles(new Set(["2", "gone"]), groups).map((entry) => entry.fileId)).toEqual(["2"]);
    expect(chosenFiles(null, groups)).toEqual([]);
  });
});

describe("fileRowAction", () => {
  it("matches what the web row does for each preview kind", () => {
    expect(fileRowAction("download").open).toBe("download");
    expect(fileRowAction("pdf").open).toBe("browser");
    expect(fileRowAction("image").open).toBe("sheet");
    expect(fileRowAction("markdown").open).toBe("sheet");
    expect(fileRowAction("text").open).toBe("sheet");
  });
});
