import type { PersonalRoutineSchedule } from "@t3tools/contracts";

import {
  addDays,
  formatLocal,
  formatLocalWithOffset,
  isoWeekday,
  localAt,
  localToInstant,
  parseLocal,
  parseTime,
} from "./zonedTime.ts";

export interface RoutineSlot {
  /** Nominal local key; the occurrence primary key with the routine id. */
  readonly localKey: string;
  readonly dueMs: number;
}

const HOUR_MS = 3_600_000;

/**
 * The first slot strictly after `afterMs`, or null when the schedule has no
 * more (a one-off in the past). Wall-clock kinds (daily, weekly, once) key on
 * the nominal local time, so an autumn-ambiguous 01:30 yields one slot (the
 * first instant) and a spring-gap 01:30 fires at the transition moment.
 * Interval schedules count elapsed hours from their anchor.
 */
export function nextRoutineSlot(
  schedule: PersonalRoutineSchedule,
  timeZone: string,
  afterMs: number,
): RoutineSlot | null {
  switch (schedule.kind) {
    case "daily":
    case "weekly": {
      const time = parseTime(schedule.time);
      if (time === null) return null;
      const start = addDays(localAt(afterMs, timeZone), -1);
      // Nine days covers a weekly schedule with one allowed day plus DST.
      for (let offset = 0; offset < 9; offset += 1) {
        const date = addDays(start, offset);
        if (schedule.kind === "weekly" && !schedule.days.includes(isoWeekday(date))) continue;
        const local = { ...date, ...time };
        const { instantMs } = localToInstant(local, timeZone);
        if (instantMs > afterMs) {
          return { localKey: formatLocal(local), dueMs: instantMs };
        }
      }
      return null;
    }
    case "interval": {
      const anchorMs = schedule.anchorAt === undefined ? Number.NaN : Date.parse(schedule.anchorAt);
      if (!Number.isFinite(anchorMs)) return null;
      const step = schedule.everyHours * HOUR_MS;
      const index = afterMs < anchorMs ? 0 : Math.floor((afterMs - anchorMs) / step) + 1;
      const dueMs = anchorMs + index * step;
      return { localKey: formatLocalWithOffset(dueMs, timeZone), dueMs };
    }
    case "once": {
      const local = parseLocal(schedule.at);
      if (local === null) return null;
      const { instantMs } = localToInstant(local, timeZone);
      return instantMs > afterMs ? { localKey: formatLocal(local), dueMs: instantMs } : null;
    }
  }
}

/** Bounds catch-up enumeration (an hourly routine asleep for two years). */
const MAX_SLOTS_SCANNED = 20_000;

/**
 * Every slot from the one due at `nextDueMs` up to `nowMs`: returns the latest
 * due slot and how many were due. `null` when nothing is due yet.
 */
export function dueRoutineSlots(
  schedule: PersonalRoutineSchedule,
  timeZone: string,
  nextDueMs: number,
  nowMs: number,
): { readonly latest: RoutineSlot; readonly count: number } | null {
  let slot = nextRoutineSlot(schedule, timeZone, nextDueMs - 1);
  let latest: RoutineSlot | null = null;
  let count = 0;
  while (slot !== null && slot.dueMs <= nowMs && count < MAX_SLOTS_SCANNED) {
    latest = slot;
    count += 1;
    slot = nextRoutineSlot(schedule, timeZone, slot.dueMs);
  }
  return latest === null ? null : { latest, count };
}
