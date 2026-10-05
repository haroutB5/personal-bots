import { describe, expect, it } from "vite-plus/test";

import type { PersonalRoutine } from "@t3tools/contracts";

import {
  defaultRoutineBotId,
  draftFromRoutine,
  notifyModeAllowed,
  notifyModeFromDraft,
  sameSchedule,
  scheduleFromDraft,
  todayInZone,
} from "./routineDraft";

const blank = draftFromRoutine(null, "bot-1", "2026-09-14");

describe("routine drafts", () => {
  it("defaults to a weekday-ready daily 09:00 in Europe/London with catch-up", () => {
    expect(blank).toMatchObject({
      botId: "bot-1",
      kind: "daily",
      time: "09:00",
      timeZone: "Europe/London",
      missedPolicy: "coalesce",
    });
  });

  it("builds each schedule kind and reports what is missing", () => {
    expect(scheduleFromDraft({ ...blank, kind: "weekly", days: [5, 1] })).toEqual({
      schedule: { kind: "weekly", days: [1, 5], time: "09:00" },
    });
    expect(scheduleFromDraft({ ...blank, kind: "weekly", days: [] })).toEqual({
      error: "Pick at least one day.",
    });
    expect(scheduleFromDraft({ ...blank, kind: "interval", everyHours: "0" })).toMatchObject({
      error: expect.stringContaining("1 to 168"),
    });
    expect(
      scheduleFromDraft({ ...blank, kind: "once", date: "2026-12-24", time: "18:30" }),
    ).toEqual({
      schedule: { kind: "once", at: "2026-12-24T18:30" },
    });
    expect(scheduleFromDraft({ ...blank, time: "" })).toEqual({ error: "Pick a time." });
  });

  it("round-trips a stored one-off and ignores the interval anchor when comparing", () => {
    expect(
      sameSchedule(
        { kind: "interval", everyHours: 3, anchorAt: "2026-09-14T08:00:00.000Z" },
        { kind: "interval", everyHours: 3 },
      ),
    ).toBe(true);
    expect(sameSchedule({ kind: "daily", time: "09:00" }, { kind: "daily", time: "09:30" })).toBe(
      false,
    );
  });

  it("reads today's date in the routine's zone", () => {
    // 23:30 UTC on the 14th is already the 15th in London (BST).
    expect(todayInZone(Date.parse("2026-09-14T23:30:00Z"), "Europe/London")).toBe("2026-09-15");
  });
});

describe("routine notify mode", () => {
  const stored = (extra: Record<string, unknown>) =>
    ({
      botId: "bot-1",
      title: "T",
      prompt: "P",
      trigger: "schedule",
      eventLabel: null,
      timeZone: "Europe/London",
      missedPolicy: "coalesce",
      schedule: { kind: "daily", time: "08:30" },
      ...extra,
    }) as unknown as PersonalRoutine;

  it("defaults to always for a new routine", () => {
    expect(blank.notifyMode).toBe("always");
    expect(blank.delivery).toBe("model");
  });

  it("reads an older routine with no notifyMode as always", () => {
    expect(draftFromRoutine(stored({}), "", "2026-09-14").notifyMode).toBe("always");
  });

  it("round-trips a stored mode into the edit draft", () => {
    expect(draftFromRoutine(stored({ notifyMode: "never" }), "", "2026-09-14").notifyMode).toBe(
      "never",
    );
    expect(
      draftFromRoutine(stored({ notifyMode: "bot_decides" }), "", "2026-09-14").notifyMode,
    ).toBe("bot_decides");
  });

  it("coerces bot_decides to always for a relay routine, which has no model", () => {
    expect(notifyModeAllowed("bot_decides", "relay")).toBe(false);
    expect(notifyModeAllowed("bot_decides", "model")).toBe(true);
    expect(notifyModeAllowed("never", "relay")).toBe(true);
    expect(notifyModeFromDraft({ notifyMode: "bot_decides", delivery: "relay" })).toBe("always");
    expect(notifyModeFromDraft({ notifyMode: "never", delivery: "relay" })).toBe("never");
    const relay = draftFromRoutine(
      stored({ delivery: "relay", notifyMode: "bot_decides" }),
      "",
      "2026-09-14",
    );
    expect(relay).toMatchObject({ delivery: "relay", notifyMode: "always" });
  });
});

describe("defaultRoutineBotId", () => {
  const bot = (botId: string, name: string) => ({ botId, name });

  it("is Planner when there is one, wherever it sorts", () => {
    expect(defaultRoutineBotId([bot("a", "Assistant"), bot("p", "Planner")])).toBe("p");
  });

  it("falls back to the first bot, and to nothing before the list loads", () => {
    expect(defaultRoutineBotId([bot("a", "Assistant"), bot("c", "CTO")])).toBe("a");
    expect(defaultRoutineBotId([])).toBe("");
  });
});
