import { describe, expect, it } from "vite-plus/test";

import {
  buildWidgetFeed,
  FEED_VERSION,
  MAX_ACTIVITY,
  MAX_QUESTION,
  MAX_WIDGET_BOTS,
  widgetFeedIsLive,
  widgetText,
  type WidgetFeedInput,
} from "./widgetFeed";

const NOW = new Date(2026, 10, 12, 15, 0, 0).getTime();

const bot = (
  botId: string,
  name: string,
  fields: {
    pinned?: boolean;
    enabled?: boolean;
    hidePreviews?: boolean;
    avatarColor?: string;
  } = {},
) => ({ botId, name, ...fields });

const feed = (input: Partial<WidgetFeedInput>) =>
  buildWidgetFeed({ bots: [], threads: [], now: NOW, ...input });

const thread = (
  botId: string,
  state: "working" | "waiting" = "working",
  threadId = `t-${botId}`,
) => ({ threadId, botId, title: `Chat ${botId}`, state });

describe("the widget feed", () => {
  it("is version 2 and empty with nothing pinned and nothing working", () => {
    expect(feed({ bots: [bot("a", "Juno")] })).toEqual({ v: FEED_VERSION, bots: [] });
  });

  it("lists pinned bots and any working or waiting bot: working, then waiting, then idle", () => {
    const out = feed({
      bots: [
        bot("a", "Juno", { pinned: true }),
        bot("b", "Forge"),
        bot("c", "Nova", { pinned: true }),
        bot("d", "Poteto"),
      ],
      threads: [thread("d", "waiting"), thread("b"), thread("c")],
    });
    expect(out.bots).toEqual([
      { botId: "b", name: "Forge", working: true },
      { botId: "c", name: "Nova", working: true },
      { botId: "d", name: "Poteto", working: false, waiting: true },
      { botId: "a", name: "Juno", working: false },
    ]);
  });

  it("skips disabled bots and caps the list", () => {
    const many = Array.from({ length: 12 }, (_, i) => bot(`b${i}`, `Bot ${i}`, { pinned: true }));
    expect(feed({ bots: many }).bots).toHaveLength(MAX_WIDGET_BOTS);
    expect(feed({ bots: [bot("a", "Off", { pinned: true, enabled: false })] }).bots).toEqual([]);
  });

  it("carries what a working bot is doing, since when, unread and its colour", () => {
    const out = feed({
      bots: [bot("a", "Builder", { avatarColor: "#3987e5" }), bot("b", "CFO", { pinned: true })],
      threads: [{ ...thread("a"), sinceMs: NOW - 60_000 }],
      notes: new Map([["t-a", "Avatar poses"]]),
      unreadByBot: new Map([["b", 3]]),
    });
    expect(out.bots).toEqual([
      {
        botId: "a",
        name: "Builder",
        working: true,
        activity: "Avatar poses",
        sinceMs: NOW - 60_000,
        color: "#3987e5",
      },
      { botId: "b", name: "CFO", working: false, unread: 3 },
    ]);
  });

  it("words a raw step type and drops one it has no words for", () => {
    const out = feed({
      bots: [bot("a", "A"), bot("b", "B")],
      threads: [thread("a"), thread("b")],
      notes: new Map([
        ["t-a", "command_execution"],
        ["t-b", "user_input_request"],
      ]),
    });
    expect(out.bots[0]?.activity).toBe("Running a command");
    expect(out.bots[1]).not.toHaveProperty("activity");
  });

  it("cleans and caps every string", () => {
    expect(widgetText("  a\u0000\nb\t c  ", 60)).toBe("a b c");
    expect(widgetText("x".repeat(200), MAX_ACTIVITY)).toHaveLength(MAX_ACTIVITY);
    const out = feed({
      bots: [bot("a", "A")],
      threads: [thread("a")],
      notes: new Map([["t-a", `step\u0007 ${"y".repeat(300)}`]]),
    });
    expect(out.bots[0]?.activity?.length).toBe(MAX_ACTIVITY);
    expect(out.bots[0]?.activity).not.toMatch(/[\u0000-\u001f]/);
  });

  it("rejects a colour that is not #rrggbb", () => {
    const out = feed({ bots: [bot("a", "A", { pinned: true, avatarColor: "red" })] });
    expect(out.bots[0]).not.toHaveProperty("color");
  });

  describe("a bot with hidden previews", () => {
    const hidden = bot("a", "Juno", { pinned: true, hidePreviews: true });
    const out = feed({
      bots: [hidden],
      threads: [thread("a", "waiting", "t1")],
      notes: new Map([["t1", "reading secrets.env"]]),
      messages: [
        {
          threadId: "t1",
          botId: "a",
          role: "assistant",
          text: "my bank pin is 1234\n```choices\nYes\nNo\n```",
          atMs: NOW,
          chatTitle: "private chat",
        },
      ],
      tasks: [{ title: "Move the money", botId: "a", status: "completed", completedAtMs: NOW }],
    });

    it("gives its name and state only", () => {
      const json = JSON.stringify(out);
      for (const secret of ["bank pin", "secrets.env", "private chat", "Move the money", "Yes"]) {
        expect(json).not.toContain(secret);
      }
      expect(out.question).toEqual({
        botId: "a",
        botName: "Juno",
        chatTitle: "",
        text: "",
        choices: [],
        link: "hbots://chat/a/t1",
        atMs: NOW,
      });
      expect(out.today?.events[0]).toEqual({ kind: "done", title: "", bot: "Juno", atMs: NOW });
    });
  });

  describe("the question card", () => {
    const message = (threadId: string, botId: string, text: string, atMs: number) => ({
      threadId,
      botId,
      role: "assistant",
      text,
      atMs,
      chatTitle: "Hbots",
    });

    it("is absent when nothing waits", () => {
      expect(feed({ bots: [bot("a", "A", { pinned: true })] })).not.toHaveProperty("question");
    });

    it("takes the newest reply that ends in choices, at most three of them", () => {
      const out = feed({
        bots: [bot("p", "Poteto")],
        messages: [
          message("t1", "p", "Old?\n```choices\nA\nB\n```", NOW - 5000),
          message(
            "t2",
            "p",
            "Ship now, or wait?\n```choices\nShip now\nWait\nLater\nNever\n```",
            NOW,
          ),
          message("t3", "p", "No choices here", NOW + 1),
        ],
      });
      expect(out.question).toEqual({
        botId: "p",
        botName: "Poteto",
        chatTitle: "Hbots",
        text: "Ship now, or wait?",
        choices: ["Ship now", "Wait", "Later"],
        link: "hbots://chat/p/t2",
        atMs: NOW,
      });
    });

    it("puts a chat parked on an answer ahead of a set of choices", () => {
      const out = feed({
        bots: [bot("p", "Poteto"), bot("b", "Builder")],
        threads: [thread("b", "waiting", "tb")],
        messages: [message("t2", "p", "Pick\n```choices\nA\nB\n```", NOW)],
      });
      expect(out.question?.botId).toBe("b");
      expect(out.question?.link).toBe("hbots://chat/b/tb");
      expect(out.question?.choices).toEqual([]);
    });

    it("caps the text and ignores a user's own message", () => {
      const long = feed({
        bots: [bot("p", "P")],
        messages: [message("t", "p", `${"w ".repeat(200)}\n\`\`\`choices\nA\nB\n\`\`\``, NOW)],
      });
      expect(long.question?.text.length).toBeLessThanOrEqual(MAX_QUESTION);
      const own = feed({
        bots: [bot("p", "P")],
        messages: [{ ...message("t", "p", "x\n```choices\nA\nB\n```", NOW), role: "user" }],
      });
      expect(own).not.toHaveProperty("question");
    });
  });

  describe("today", () => {
    const task = (title: string, status: string, completedAtMs: number | null, botId = "s") => ({
      title,
      botId,
      status,
      completedAtMs,
    });

    it("counts today's work and lists the newest three, done or failed", () => {
      const out = feed({
        bots: [bot("s", "Shipper")],
        tasks: [
          task("One", "completed", NOW - 4000),
          task("Two", "failed", NOW - 3000),
          task("Three", "completed", NOW - 2000),
          task("Four", "completed", NOW - 1000),
          task("Yesterday", "completed", NOW - 26 * 3_600_000),
          task("Stopped", "cancelled", NOW - 500),
          task("Now", "running", null),
          task("Also now", "running", null),
        ],
      });
      expect(out.today).toEqual({
        done: 3,
        failed: 1,
        running: 2,
        events: [
          { kind: "done", title: "Four", bot: "Shipper", atMs: NOW - 1000 },
          { kind: "done", title: "Three", bot: "Shipper", atMs: NOW - 2000 },
          { kind: "failed", title: "Two", bot: "Shipper", atMs: NOW - 3000 },
        ],
      });
    });

    it("names the next enabled routine that is still to come", () => {
      const out = feed({
        routines: [
          { title: "Past", enabled: true, nextDueAtMs: NOW - 1 },
          { title: "Off", enabled: false, nextDueAtMs: NOW + 10 },
          { title: "Tennis Friday", enabled: true, nextDueAtMs: NOW + 5000 },
          { title: "Later", enabled: true, nextDueAtMs: NOW + 9000 },
          { title: "Event", enabled: true, nextDueAtMs: null },
        ],
      });
      expect(out.today?.next).toEqual({ title: "Tennis Friday", atMs: NOW + 5000 });
    });

    it("is absent until the task feed or the routines have answered", () => {
      expect(feed({})).not.toHaveProperty("today");
    });
  });

  describe("usage and machines", () => {
    it("leaves usage out when the provider reports neither window", () => {
      const none = feed({
        usage: { title: "Claude", sessionPct: null, weekPct: null, resets: null },
      });
      expect(none).not.toHaveProperty("usage");
      const some = feed({
        usage: { title: "Claude", sessionPct: 61.6, weekPct: null, resets: "17:10" },
      });
      expect(some.usage).toEqual({
        title: "Claude",
        sessionPct: 62,
        weekPct: null,
        resets: "17:10",
      });
    });

    it("rounds the laptop figures and adds the gaming PC only when it is on", () => {
      const system = {
        cpuPct: 22.6,
        memUsedGB: 11.2,
        memTotalGB: 31.3,
        cpuTempC: 54.4,
        diskFreeGB: 212.4,
        gamingPc: { state: "starting" as const },
      };
      const off = feed({ system });
      expect(off.laptop).toEqual({
        cpuPct: 23,
        memUsedGB: 11,
        memTotalGB: 31,
        tempC: 54,
        diskFreeGB: 212,
      });
      expect(off).not.toHaveProperty("gamingPc");
      const on = feed({
        system: {
          ...system,
          gamingPc: {
            state: "on",
            cpuPct: 32,
            gpuPct: null,
            memUsedGB: 12.4,
            memTotalGB: 16,
            users: [
              { kind: "bot", bot: "Builder" },
              { kind: "game", label: "League" },
            ],
          },
        },
      });
      expect(on.gamingPc).toEqual({
        cpuPct: 32,
        memUsedGB: 12,
        memTotalGB: 16,
        gpuPct: null,
        users: ["Builder", "League"],
      });
    });
  });

  it("needs the heartbeat only while a bot works", () => {
    expect(widgetFeedIsLive(null)).toBe(false);
    expect(widgetFeedIsLive(feed({ bots: [bot("a", "A", { pinned: true })] }))).toBe(false);
    expect(widgetFeedIsLive(feed({ bots: [bot("a", "A")], threads: [thread("a")] }))).toBe(true);
  });
});
