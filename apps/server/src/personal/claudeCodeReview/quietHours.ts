/**
 * Quiet hours for the Updates bot: it works at night while Harout sleeps, so
 * between 00:00 and 07:00 London its notifications do not push unless
 * something is broken.
 *
 * - The nightly run's own "finished" is dropped: the morning report follows.
 * - The morning report is deferred to 07:00, unless it is urgent (it starts
 *   with URGENT_REPORT_PREFIX: Bots may not be on a known-good release).
 * - Anything else it finishes is deferred to 07:00.
 * - A failure or a "needs you" goes out at once: that is something broken.
 *
 * This is not a mute: the bot's mute (1.34.0) still silences everything, and
 * outside the window every notification behaves as for any other bot.
 *
 * @module personal/claudeCodeReview/quietHours
 */
import type { PersonalTask } from "@t3tools/contracts";

import { localAt, localToInstant } from "../routines/zonedTime.ts";
import { isUrgentReport } from "./proposalLedger.ts";
import {
  UPDATES_BOT_ID,
  UPDATES_NIGHTLY_ROUTINE_ID,
  UPDATES_REPORT_ROUTINE_ID,
} from "./reviewPrompts.ts";

export const QUIET_HOURS_TIME_ZONE = "Europe/London";
/** Local hours [start, end): 00:00 up to 07:00. */
export const QUIET_HOURS_START_HOUR = 0;
export const QUIET_HOURS_END_HOUR = 7;

export type QuietHoursVerdict =
  | { readonly _tag: "Now" }
  | { readonly _tag: "Drop" }
  | { readonly _tag: "DeferUntil"; readonly atMs: number };

/** The instant the current quiet window ends, or null when `nowMs` is outside it. */
export function quietWindowEnd(nowMs: number, timeZone = QUIET_HOURS_TIME_ZONE): number | null {
  const local = localAt(nowMs, timeZone);
  if (local.hour < QUIET_HOURS_START_HOUR || local.hour >= QUIET_HOURS_END_HOUR) return null;
  return localToInstant(
    { year: local.year, month: local.month, day: local.day, hour: QUIET_HOURS_END_HOUR, minute: 0 },
    timeZone,
  ).instantMs;
}

/** The task notification kinds the push service sends (mirrors its PersonalPushEventKind). */
export type QuietHoursTaskKind =
  | "task_completed"
  | "task_needs_input"
  | "task_failed"
  | "routine_result";

const routinePrefix = (routineId: string) => `routine:${routineId}:`;

/** What quiet hours do to one task notification. */
export function updatesQuietHoursVerdict(
  task: Pick<PersonalTask, "botId" | "idempotencyKey" | "objective" | "result">,
  kind: QuietHoursTaskKind,
  nowMs: number,
): QuietHoursVerdict {
  if (task.botId !== UPDATES_BOT_ID) return { _tag: "Now" };
  const end = quietWindowEnd(nowMs);
  if (end === null) return { _tag: "Now" };
  if (kind === "task_failed" || kind === "task_needs_input") return { _tag: "Now" };
  if (task.idempotencyKey.startsWith(routinePrefix(UPDATES_REPORT_ROUTINE_ID))) {
    return isUrgentReport(task.result?.summary ?? task.objective)
      ? { _tag: "Now" }
      : { _tag: "DeferUntil", atMs: end };
  }
  if (task.idempotencyKey.startsWith(routinePrefix(UPDATES_NIGHTLY_ROUTINE_ID))) {
    return { _tag: "Drop" };
  }
  return { _tag: "DeferUntil", atMs: end };
}
