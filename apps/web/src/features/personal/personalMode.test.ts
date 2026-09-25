import { describe, expect, it } from "vite-plus/test";

import {
  activeTabFor,
  botSelectionKey,
  desktopPaneLayout,
  groupSelectionKey,
  isPersonalPath,
  sidebarSelectionKey,
} from "./personalMode";

describe("sidebarSelectionKey", () => {
  it("selects the bot for any of its chats, its chats list and its editor", () => {
    // /bots/$botId/$threadId: an older thread still selects the bot's row.
    expect(sidebarSelectionKey({ botId: "b1", threadId: "t1" } as { botId: string })).toBe(
      "bot:b1",
    );
    // /bots/$botId (the bot's chats) and /bots/$botId/edit.
    expect(sidebarSelectionKey({ botId: "b1" })).toBe("bot:b1");
    expect(sidebarSelectionKey({ botId: "b1" })).toBe(botSelectionKey("b1"));
  });

  it("selects the group for a group chat", () => {
    expect(sidebarSelectionKey({ groupId: "g1" })).toBe("group:g1");
    expect(sidebarSelectionKey({ groupId: "g1" })).toBe(groupSelectionKey("g1"));
  });

  it("selects nothing on Team/home, Tasks, Files, Computer and the forms", () => {
    // /bots, /bots/team, /bots/settings, /bots/new, /bots/groups/new, /files,
    // /computer (its bot rides in the search, not a param), /tasks and task or
    // routine detail: none of them carries a botId or groupId param.
    expect(sidebarSelectionKey({})).toBeNull();
    expect(sidebarSelectionKey({ taskId: "t1" } as {})).toBeNull();
    expect(sidebarSelectionKey({ routineId: "r1" } as {})).toBeNull();
    expect(sidebarSelectionKey({ botId: undefined, groupId: undefined })).toBeNull();
    expect(sidebarSelectionKey({ botId: "" })).toBeNull();
  });

  it("keeps bot and group keys apart even when the ids collide", () => {
    expect(botSelectionKey("x")).not.toBe(groupSelectionKey("x"));
  });
});

describe("isPersonalPath", () => {
  it("claims the four tabs and everything under /bots and /tasks", () => {
    for (const path of [
      "/bots",
      "/bots/",
      "/bots/new",
      "/bots/b1/edit",
      "/tasks",
      "/tasks/t1",
      "/tasks/routines/r1",
      "/files",
    ]) {
      expect(isPersonalPath(path)).toBe(true);
    }
    expect(isPersonalPath("/computer")).toBe(true);
  });

  it("leaves upstream routes alone", () => {
    for (const path of ["/", "/settings", "/botsy", "/env/thread", "/tasksy"]) {
      expect(isPersonalPath(path)).toBe(false);
    }
  });
});

describe("activeTabFor", () => {
  it("maps tab roots and hides the bar on focused editors", () => {
    expect(activeTabFor("/bots")).toBe("chats");
    expect(activeTabFor("/bots/settings")).toBe("chats");
    expect(activeTabFor("/bots/team")).toBe("chats");
    expect(activeTabFor("/computer")).toBe("computer");
    expect(activeTabFor("/bots/new")).toBeNull();
    expect(activeTabFor("/bots/b1/edit")).toBeNull();
  });

  it("keeps the Tasks tab on task and routine detail, not on the routine editor", () => {
    expect(activeTabFor("/tasks/t1")).toBe("tasks");
    expect(activeTabFor("/tasks/routines/r1")).toBe("tasks");
    expect(activeTabFor("/tasks/routines/new")).toBeNull();
    expect(activeTabFor("/tasks/routines/r1/edit")).toBeNull();
  });
});

describe("desktopPaneLayout", () => {
  it("lets a chat (bot or group) fill the pane", () => {
    expect(desktopPaneLayout("/bots/b1/t1")).toBe("conversation");
    expect(desktopPaneLayout("/bots/b1/t1/")).toBe("conversation");
    expect(desktopPaneLayout("/bots/groups/g1")).toBe("conversation");
  });

  it("puts editors and settings in the form column, even where they look like a chat path", () => {
    for (const path of [
      "/bots/new",
      "/bots/b1/edit",
      "/bots/groups/new",
      "/bots/settings",
      "/bots/settings/connections",
      "/bots/settings/passwords",
      "/bots/settings/api-keys",
      "/tasks/routines/new",
      "/tasks/routines/r1/edit",
    ]) {
      expect(desktopPaneLayout(path)).toBe("form");
    }
  });

  it("keeps lists and detail screens in the reading column", () => {
    for (const path of [
      "/bots",
      "/bots/team",
      "/bots/b1",
      "/tasks",
      "/tasks/t1",
      "/tasks/routines/r1",
      "/computer",
      "/files",
    ]) {
      expect(desktopPaneLayout(path)).toBe("column");
    }
  });
});
