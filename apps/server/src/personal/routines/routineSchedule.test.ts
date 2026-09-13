// @effect-diagnostics globalDate:off - fixtures compare epoch milliseconds.
import { describe, expect, it } from "@effect/vitest";

import { dueRoutineSlots, nextRoutineSlot } from "./routineSchedule.ts";
import { localToInstant } from "./zonedTime.ts";

const LONDON = "Europe/London";
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

describe("Europe/London wall-clock slots", () => {
  it("spring-forward: a nonexistent 01:30 runs at the transition (02:00 BST)", () => {
    const slot = nextRoutineSlot(
      { kind: "daily", time: "01:30" },
      LONDON,
      at("2026-03-28T12:00:00Z"),
    );
    expect(slot?.localKey).toBe("2026-03-29T01:30");
    expect(iso(slot!.dueMs)).toBe("2026-03-29T01:00:00.000Z");
    expect(localToInstant({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 }, LONDON)).toEqual({
      instantMs: at("2026-03-29T01:00:00Z"),
      resolution: "gap",
    });
    // The next day is ordinary BST again.
    expect(iso(nextRoutineSlot({ kind: "daily", time: "01:30" }, LONDON, slot!.dueMs)!.dueMs)).toBe(
      "2026-03-30T00:30:00.000Z",
    );
  });

  it("fall-back: an ambiguous 01:30 runs once, at the first instance", () => {
    const schedule = { kind: "daily", time: "01:30" } as const;
    const first = nextRoutineSlot(schedule, LONDON, at("2026-10-24T12:00:00Z"));
    expect(first?.localKey).toBe("2026-10-25T01:30");
    expect(iso(first!.dueMs)).toBe("2026-10-25T00:30:00.000Z");
    // After the first instance, the repeat (01:30 GMT) is not a new slot.
    const next = nextRoutineSlot(schedule, LONDON, first!.dueMs);
    expect(next?.localKey).toBe("2026-10-26T01:30");
    expect(iso(next!.dueMs)).toBe("2026-10-26T01:30:00.000Z");
    // Enumerating across the whole repeated hour still yields one slot.
    expect(dueRoutineSlots(schedule, LONDON, first!.dueMs, at("2026-10-25T01:45:00Z"))?.count).toBe(
      1,
    );
  });

  it("a daily 09:00 stays at 09:00 local across both transitions", () => {
    const schedule = { kind: "daily", time: "09:00" } as const;
    const utcTimes: Array<string> = [];
    let after = at("2026-03-27T12:00:00Z");
    for (let index = 0; index < 3; index += 1) {
      const slot = nextRoutineSlot(schedule, LONDON, after)!;
      utcTimes.push(iso(slot.dueMs));
      after = slot.dueMs;
    }
    expect(utcTimes).toEqual([
      "2026-03-28T09:00:00.000Z",
      "2026-03-29T08:00:00.000Z",
      "2026-03-30T08:00:00.000Z",
    ]);
    expect(iso(nextRoutineSlot(schedule, LONDON, at("2026-10-25T00:00:00Z"))!.dueMs)).toBe(
      "2026-10-25T09:00:00.000Z",
    );
  });

  it("weekly schedules only land on the chosen ISO weekdays", () => {
    // 2026-09-14 is a Monday.
    const slot = nextRoutineSlot(
      { kind: "weekly", days: [3, 5], time: "07:15" },
      LONDON,
      at("2026-09-14T12:00:00Z"),
    );
    expect(slot?.localKey).toBe("2026-09-16T07:15");
    expect(iso(slot!.dueMs)).toBe("2026-09-16T06:15:00.000Z");
  });

  it("interval schedules count elapsed hours from the anchor and key with the offset", () => {
    const schedule = {
      kind: "interval",
      everyHours: 3,
      anchorAt: "2026-10-24T22:00:00.000Z",
    } as const;
    const first = nextRoutineSlot(schedule, LONDON, at("2026-10-24T22:00:00Z"))!;
    expect(iso(first.dueMs)).toBe("2026-10-25T01:00:00.000Z");
    expect(first.localKey).toBe("2026-10-25T01:00+00:00");
    const due = dueRoutineSlots(schedule, LONDON, first.dueMs, at("2026-10-25T10:30:00Z"));
    expect(due?.count).toBe(4);
    expect(iso(due!.latest.dueMs)).toBe("2026-10-25T10:00:00.000Z");
  });

  it("a one-off in the past has no slot", () => {
    const schedule = { kind: "once", at: "2026-09-14T09:00" } as const;
    expect(nextRoutineSlot(schedule, LONDON, at("2026-09-14T07:00:00Z"))?.localKey).toBe(
      "2026-09-14T09:00",
    );
    expect(nextRoutineSlot(schedule, LONDON, at("2026-09-14T09:00:00Z"))).toBeNull();
  });

  it("coalesces long interval backlogs to the actual latest run", () => {
    const schedule = {
      kind: "interval",
      everyHours: 1,
      anchorAt: "2020-01-01T00:00:00.000Z",
    } as const;
    const first = at(schedule.anchorAt);
    const now = first + 25_000 * 3_600_000;
    const due = dueRoutineSlots(schedule, LONDON, first, now);
    expect(due?.count).toBe(25_001);
    expect(due?.latest.dueMs).toBe(now);
    expect(dueRoutineSlots(schedule, LONDON, now + 3_600_000, now)).toBeNull();
  });
});
