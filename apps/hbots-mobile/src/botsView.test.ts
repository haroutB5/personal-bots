import { describe, expect, it } from "vite-plus/test";

import type { CachedBots } from "./botsCache";
import { connectionStripText, offlineBotsView, savedBotsView, serverBotsView } from "./botsView";

const SAVED: CachedBots = {
  version: 1,
  environmentId: "env-1",
  savedAtMs: new Date(2026, 10, 2, 14, 2).getTime(),
  serverVersion: "1.66.110",
  rows: [
    {
      botId: "b1",
      name: "Juno",
      lead: true,
      title: "Lead",
      model: "claude/claude-opus-5-5",
      chats: 1,
    },
  ],
};

const REFRESHED: CachedBots = {
  ...SAVED,
  savedAtMs: new Date(2026, 10, 2, 14, 3).getTime(),
  rows: [
    ...SAVED.rows,
    {
      botId: "b2",
      name: "Scout",
      lead: false,
      title: "",
      model: "claude/claude-opus-5-5",
      chats: 2,
    },
  ],
};

describe("bots view", () => {
  it("paints a saved list as connecting, not live", () => {
    const view = savedBotsView(SAVED, 1_000);

    expect(view.rows).toEqual(SAVED.rows);
    expect(view.source).toBe("saved");
    expect(view.connection).toEqual({ kind: "connecting", since: 1_000 });
    expect(connectionStripText(view)).toBe("Updating · showing 14:02");
  });

  it("replaces the saved list with the background refresh", () => {
    const view = serverBotsView(REFRESHED);

    expect(view.rows.map((row) => row.botId)).toEqual(["b1", "b2"]);
    expect(view.rows[1]?.chats).toBe(2);
    expect(view.source).toBe("server");
    expect(view.connection).toEqual({ kind: "online" });
    expect(connectionStripText(view)).toBeNull();
  });

  it("keeps the rows and marks them offline when a refresh fails", () => {
    const view = offlineBotsView(savedBotsView(SAVED, 1_000), 5_000, 2);

    expect(view.rows).toEqual(SAVED.rows);
    expect(view.connection).toEqual({ kind: "offline", since: 5_000, attempt: 2 });
    expect(connectionStripText(view)).toBe("Offline · showing 14:02");
  });
});
