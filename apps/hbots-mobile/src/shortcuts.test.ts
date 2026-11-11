import { describe, expect, it } from "vite-plus/test";

import { buildShortcutFeed, MAX_SHORTCUTS, shortcutFeedKey } from "./shortcuts";

const bot = (
  botId: string,
  name: string,
  fields: { pinned?: boolean; enabled?: boolean; team?: string; lead?: boolean } = {},
) => ({ botId, name, ...fields });

describe("the launcher shortcut feed", () => {
  it("is empty with no bots and with no pins", () => {
    expect(buildShortcutFeed([])).toEqual([]);
    expect(buildShortcutFeed([bot("a", "Juno"), bot("b", "Forge")])).toEqual([]);
  });

  it("lists one pinned bot as id and name only", () => {
    expect(buildShortcutFeed([bot("a", "Juno", { pinned: true }), bot("b", "Forge")])).toEqual([
      { botId: "a", name: "Juno" },
    ]);
  });

  it("keeps the list's order and caps at four", () => {
    const bots = ["a", "b", "c", "d", "e", "f"].map((id) =>
      bot(id, id.toUpperCase(), { pinned: true }),
    );
    const feed = buildShortcutFeed(bots);
    expect(MAX_SHORTCUTS).toBe(4);
    expect(feed.map((entry) => entry.botId)).toEqual(["a", "b", "c", "d"]);
  });

  it("skips disabled bots", () => {
    const feed = buildShortcutFeed([
      bot("a", "Off", { pinned: true, enabled: false }),
      bot("b", "On", { pinned: true }),
    ]);
    expect(feed.map((entry) => entry.botId)).toEqual(["b"]);
  });

  it("leaves the CTO out, because the static shortcut already opens it", () => {
    const feed = buildShortcutFeed([
      bot("cto", "Chief", { pinned: true, team: "dev", lead: true }),
      bot("a", "Juno", { pinned: true }),
    ]);
    expect(feed.map((entry) => entry.botId)).toEqual(["a"]);
  });

  it("changes its key only when the shortcuts change", () => {
    const one = buildShortcutFeed([bot("a", "Juno", { pinned: true })]);
    const same = buildShortcutFeed([bot("a", "Juno", { pinned: true }), bot("b", "Forge")]);
    const renamed = buildShortcutFeed([bot("a", "June", { pinned: true })]);
    expect(shortcutFeedKey(one)).toBe(shortcutFeedKey(same));
    expect(shortcutFeedKey(one)).not.toBe(shortcutFeedKey(renamed));
  });
});
