import { describe, expect, it } from "vite-plus/test";

import { botsHomeState, snapshotRowTarget } from "./botsHomeState";

describe("Bots home states", () => {
  it("paints the cache before the live list", () => {
    expect(
      botsHomeState({
        loaded: false,
        failed: false,
        hasSnapshot: true,
        visibleCount: 0,
        query: "",
      }),
    ).toBe("snapshot");
  });

  it("shows the skeleton on a first cold start", () => {
    expect(
      botsHomeState({
        loaded: false,
        failed: false,
        hasSnapshot: false,
        visibleCount: 0,
        query: "",
      }),
    ).toBe("loading");
  });

  it("shows the error only when nothing is cached", () => {
    expect(
      botsHomeState({
        loaded: false,
        failed: true,
        hasSnapshot: false,
        visibleCount: 0,
        query: "",
      }),
    ).toBe("error");
    expect(
      botsHomeState({ loaded: false, failed: true, hasSnapshot: true, visibleCount: 0, query: "" }),
    ).toBe("snapshot");
  });

  it("separates an empty list from a search with no hits", () => {
    expect(
      botsHomeState({
        loaded: true,
        failed: false,
        hasSnapshot: false,
        visibleCount: 0,
        query: "",
      }),
    ).toBe("empty");
    expect(
      botsHomeState({
        loaded: true,
        failed: false,
        hasSnapshot: false,
        visibleCount: 0,
        query: "  planner ",
      }),
    ).toBe("no-match");
    expect(
      botsHomeState({
        loaded: true,
        failed: false,
        hasSnapshot: false,
        visibleCount: 3,
        query: "planner",
      }),
    ).toBe("list");
  });
});

describe("snapshotRowTarget", () => {
  it("opens the cached chat when the row remembers one", () => {
    expect(snapshotRowTarget({ threadId: "thread-1" })).toEqual({
      kind: "chat",
      threadId: "thread-1",
    });
  });

  it("opens the bot when the cached row has no chat yet", () => {
    expect(snapshotRowTarget({ threadId: null })).toEqual({ kind: "bot" });
  });
});
