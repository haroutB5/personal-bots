import { describe, expect, it } from "vite-plus/test";

import { activeTabFor, isPersonalPath } from "./personalMode";

describe("isPersonalPath", () => {
  it("claims the four tabs and everything under /bots", () => {
    for (const path of ["/bots", "/bots/", "/bots/new", "/bots/b1/edit", "/tasks", "/files"]) {
      expect(isPersonalPath(path)).toBe(true);
    }
    expect(isPersonalPath("/computer")).toBe(true);
  });

  it("leaves upstream routes alone", () => {
    for (const path of ["/", "/settings", "/botsy", "/env/thread", "/tasks/extra"]) {
      expect(isPersonalPath(path)).toBe(false);
    }
  });
});

describe("activeTabFor", () => {
  it("maps tab roots and hides the bar on focused editors", () => {
    expect(activeTabFor("/bots")).toBe("chats");
    expect(activeTabFor("/bots/settings")).toBe("chats");
    expect(activeTabFor("/computer")).toBe("computer");
    expect(activeTabFor("/bots/new")).toBeNull();
    expect(activeTabFor("/bots/b1/edit")).toBeNull();
  });
});
