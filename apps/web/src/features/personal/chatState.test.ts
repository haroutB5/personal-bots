import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  isChatPinned,
  isChatSnoozed,
  nextWakeAtMs,
  pinnedFirst,
  snoozeEndMs,
  snoozePresets,
  soonestWakeFirst,
  wakeLabel,
} from "./chatState";

// Local-time dates, so the tests hold in any zone the machine runs in.
const local = (month: number, day: number, hour: number, minute = 0) =>
  new Date(2026, month - 1, day, hour, minute, 0, 0);
const utc = (date: Date) => DateTime.makeUnsafe(date.getTime());

describe("pin and snooze state", () => {
  it("a chat is pinned only when it carries pinnedAt", () => {
    expect(isChatPinned({})).toBe(false);
    expect(isChatPinned({ pinnedAt: utc(local(10, 6, 9)) })).toBe(true);
  });

  it("a snooze ends at its time, and is over once that time has passed", () => {
    const now = local(10, 6, 10);
    const until = local(10, 6, 18);
    expect(snoozeEndMs({ snoozedUntil: utc(until) }, now.getTime())).toBe(until.getTime());
    expect(isChatSnoozed({ snoozedUntil: utc(until) }, now.getTime())).toBe(true);
    expect(isChatSnoozed({ snoozedUntil: utc(until) }, until.getTime())).toBe(false);
    expect(isChatSnoozed({ snoozedUntil: utc(until) }, until.getTime() + 1)).toBe(false);
    expect(isChatSnoozed({}, now.getTime())).toBe(false);
  });

  it("finds the nearest wake time still ahead", () => {
    const now = local(10, 6, 10).getTime();
    const items = [
      { snoozedUntil: utc(local(10, 6, 18)) },
      { snoozedUntil: utc(local(10, 6, 9)) },
      { snoozedUntil: utc(local(10, 6, 12)) },
      {},
    ];
    expect(nextWakeAtMs(items, now)).toBe(local(10, 6, 12).getTime());
    expect(nextWakeAtMs([{}], now)).toBeNull();
    expect(nextWakeAtMs([], now)).toBeNull();
  });

  it("puts pinned rows first and keeps each part in its own order", () => {
    const rows = [
      { id: "a", pinned: false },
      { id: "b", pinned: true },
      { id: "c", pinned: false },
      { id: "d", pinned: true },
    ];
    expect(pinnedFirst(rows, (row) => row.pinned).map((row) => row.id)).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
  });

  it("orders snoozed rows by soonest wake", () => {
    const rows = [{ at: 30 }, { at: 10 }, { at: 20 }];
    expect(soonestWakeFirst(rows, (row) => row.at).map((row) => row.at)).toEqual([10, 20, 30]);
  });
});

describe("snoozePresets", () => {
  const byKey = (now: Date) => new Map(snoozePresets(now).map((preset) => [preset.key, preset]));

  it("offers the four choices in the morning", () => {
    const now = local(10, 6, 9, 30); // Tuesday
    const presets = snoozePresets(now);
    expect(presets.map((preset) => preset.label)).toEqual([
      "In 1 hour",
      "This evening",
      "Tomorrow",
      "Next week",
    ]);
    const map = byKey(now);
    expect(map.get("hour")?.untilMs).toBe(now.getTime() + 3_600_000);
    expect(map.get("evening")?.untilMs).toBe(local(10, 6, 18).getTime());
    expect(map.get("tomorrow")?.untilMs).toBe(local(10, 7, 9).getTime());
    // Tuesday 6 Oct: the next Monday is 12 Oct.
    expect(map.get("next-week")?.untilMs).toBe(local(10, 12, 9).getTime());
  });

  it("leaves out This evening from 17:00", () => {
    expect(byKey(local(10, 6, 16, 59)).has("evening")).toBe(true);
    expect(byKey(local(10, 6, 17, 0)).has("evening")).toBe(false);
    expect(byKey(local(10, 6, 21)).has("evening")).toBe(false);
  });

  it("Next week is the following Monday when today is a Monday", () => {
    const monday = local(10, 12, 8); // Monday 12 Oct 2026
    expect(byKey(monday).get("next-week")?.untilMs).toBe(local(10, 19, 9).getTime());
  });

  it("Next week from a Sunday is the next day", () => {
    const sunday = local(10, 11, 8); // Sunday 11 Oct 2026
    expect(byKey(sunday).get("next-week")?.untilMs).toBe(local(10, 12, 9).getTime());
  });

  it("Tomorrow rolls over the end of a month", () => {
    expect(byKey(local(10, 31, 8)).get("tomorrow")?.untilMs).toBe(local(11, 1, 9).getTime());
  });

  it("describes each choice in words", () => {
    const map = byKey(local(10, 6, 9, 30));
    expect(map.get("evening")?.detail).toBe("Today 18:00");
    expect(map.get("tomorrow")?.detail).toBe("Tomorrow 09:00");
    expect(map.get("next-week")?.detail).toBe("Mon 12 Oct 09:00");
  });
});

describe("wakeLabel", () => {
  const now = local(10, 6, 10).getTime();

  it("says today, tomorrow or the date", () => {
    expect(wakeLabel(local(10, 6, 18).getTime(), now)).toBe("Wakes today 18:00");
    expect(wakeLabel(local(10, 7, 9).getTime(), now)).toBe("Wakes tomorrow 09:00");
    expect(wakeLabel(local(10, 12, 9).getTime(), now)).toBe("Wakes Mon 12 Oct 09:00");
  });

  it("adds the year when it is not this one", () => {
    expect(wakeLabel(new Date(2027, 0, 4, 9).getTime(), now)).toBe("Wakes Mon 4 Jan 2027 09:00");
  });

  it("a time that has passed reads as waking", () => {
    expect(wakeLabel(now - 1, now)).toBe("Waking now");
  });
});
