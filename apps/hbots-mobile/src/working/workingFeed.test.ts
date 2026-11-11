import { describe, expect, it } from "vite-plus/test";

import {
  buildWorkingFeed,
  createWorkingPublisher,
  feedKey,
  MAX_FEED_BOTS,
  type WorkingFeedBot,
} from "./workingFeed";
import type { WorkingThread } from "./workingThreads";

const thread = (threadId: string, botId: string, botName: string): WorkingThread => ({
  threadId,
  botId,
  botName,
  title: "A chat title that must never reach the notification",
});

describe("buildWorkingFeed", () => {
  it("gives one entry per bot even with several running chats", () => {
    const feed = buildWorkingFeed(
      [thread("t1", "b1", "Juno"), thread("t2", "b1", "Juno"), thread("t3", "b2", "Atlas")],
      new Map([["t2", "Reading files"]]),
    );
    expect(feed).toEqual([
      { botId: "b1", name: "Juno", note: "Reading files" },
      { botId: "b2", name: "Atlas" },
    ]);
  });

  it("never carries a chat title and trims notes to 80 characters", () => {
    const feed = buildWorkingFeed([thread("t1", "b1", "Juno")], new Map([["t1", "x".repeat(200)]]));
    expect(feed[0]?.note).toHaveLength(80);
    expect(JSON.stringify(feed)).not.toContain("must never reach");
  });

  it("drops blank notes and caps the list", () => {
    const many = Array.from({ length: 12 }, (_, i) => thread(`t${i}`, `b${i}`, `Bot ${i}`));
    const feed = buildWorkingFeed(many, new Map([["t0", "   "]]));
    expect(feed).toHaveLength(MAX_FEED_BOTS);
    expect(feed[0]).toEqual({ botId: "b0", name: "Bot 0" });
  });
});

describe("createWorkingPublisher", () => {
  function setup() {
    const calls: string[] = [];
    const publisher = createWorkingPublisher({
      set: (feed) => calls.push(`set:${feed.map((bot) => bot.name).join(",")}`),
      clear: () => calls.push("clear"),
    });
    return { calls, publisher };
  }
  const juno: WorkingFeedBot[] = [{ botId: "b1", name: "Juno" }];
  const both: WorkingFeedBot[] = [...juno, { botId: "b2", name: "Atlas" }];

  it("sends a change once and ignores an identical read", () => {
    const { calls, publisher } = setup();
    publisher.update(juno);
    publisher.update([...juno]);
    publisher.update(both);
    expect(calls).toEqual(["set:Juno", "set:Juno,Atlas"]);
  });

  it("resends the current feed on a heartbeat, and nothing when idle", () => {
    const { calls, publisher } = setup();
    publisher.heartbeat();
    publisher.update(juno);
    publisher.heartbeat();
    expect(calls).toEqual(["set:Juno", "set:Juno"]);
  });

  it("clears once when the last run ends, and not for an empty start", () => {
    const { calls, publisher } = setup();
    publisher.update([]);
    publisher.update(juno);
    publisher.update([]);
    publisher.update([]);
    publisher.heartbeat();
    expect(calls).toEqual(["set:Juno", "clear"]);
  });

  it("treats an untrusted read as no change", () => {
    const { calls, publisher } = setup();
    publisher.update(juno);
    publisher.update(null);
    publisher.heartbeat();
    expect(calls).toEqual(["set:Juno", "set:Juno"]);
  });

  it("sends again after reset", () => {
    const { calls, publisher } = setup();
    publisher.update(juno);
    publisher.reset();
    publisher.update(juno);
    expect(calls).toEqual(["set:Juno", "set:Juno"]);
  });

  it("keys on id, name and note", () => {
    expect(feedKey(juno)).not.toBe(feedKey([{ ...juno[0]!, note: "x" }]));
  });
});
