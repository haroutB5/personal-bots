import { describe, expect, it } from "vite-plus/test";

import {
  beginStop,
  EMPTY_HEADLINE,
  failStop,
  pruneAttempts,
  stopListView,
  type StopAttempts,
} from "./stopListModel";
import type { WorkingThread } from "./workingThreads";

const none: StopAttempts = new Map();
const thread = (threadId: string, botId: string, botName: string): WorkingThread => ({
  threadId,
  botId,
  botName,
  title: `Chat ${threadId}`,
  state: "working",
});

describe("stopListView", () => {
  it("is empty when nothing runs", () => {
    expect(stopListView([], none)).toEqual({ kind: "empty", headline: EMPTY_HEADLINE });
  });

  it("shows one working chat with a Stop button", () => {
    expect(stopListView([thread("t1", "b1", "Juno")], none)).toEqual({
      kind: "list",
      headline: "1 bot working",
      rows: [
        {
          threadId: "t1",
          botName: "Juno",
          title: "Chat t1",
          state: "idle",
          message: null,
          canStop: true,
          buttonLabel: "Stop",
        },
      ],
    });
  });

  it("shows many chats and counts bots, not chats", () => {
    const view = stopListView(
      [thread("t1", "b1", "Juno"), thread("t2", "b1", "Juno"), thread("t3", "b2", "Atlas")],
      none,
    );
    expect(view.kind === "list" && view.headline).toBe("2 bots working");
    expect(view.kind === "list" && view.rows.map((row) => row.threadId)).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });

  it("disables the button of a chat that is stopping", () => {
    const view = stopListView(
      [thread("t1", "b1", "Juno"), thread("t2", "b2", "Atlas")],
      beginStop(none, "t1"),
    );
    if (view.kind !== "list") throw new Error("expected a list");
    expect(view.rows[0]).toMatchObject({
      state: "stopping",
      canStop: false,
      buttonLabel: "Stopping…",
    });
    expect(view.rows[1]).toMatchObject({ state: "idle", canStop: true, buttonLabel: "Stop" });
  });

  it("shows the failure under the row and lets the owner try again", () => {
    const view = stopListView(
      [thread("t1", "b1", "Juno")],
      failStop(beginStop(none, "t1"), "t1", "Couldn't stop this turn."),
    );
    if (view.kind !== "list") throw new Error("expected a list");
    expect(view.rows[0]).toMatchObject({
      state: "failed",
      message: "Couldn't stop this turn.",
      canStop: true,
      buttonLabel: "Try again",
    });
  });
});

describe("pruneAttempts", () => {
  it("forgets a chat that stopped running and keeps one that still runs", () => {
    const attempts = beginStop(beginStop(none, "t1"), "t2");
    const pruned = pruneAttempts(attempts, [thread("t2", "b2", "Atlas")]);
    expect([...pruned.keys()]).toEqual(["t2"]);
  });

  it("returns the same map when nothing changes", () => {
    const attempts = beginStop(none, "t1");
    expect(pruneAttempts(attempts, [thread("t1", "b1", "Juno")])).toBe(attempts);
  });
});
