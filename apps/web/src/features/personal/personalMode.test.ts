import { describe, expect, it } from "vite-plus/test";

import { activeTabFor, desktopPaneLayout, isPersonalPath } from "./personalMode";

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
