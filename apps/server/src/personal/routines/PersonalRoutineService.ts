import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PERSONAL_ROUTINE_DEFAULT_TIME_ZONE,
  PersonalBotId,
  PersonalRoutineId,
  PersonalRoutineMissedPolicy,
  PersonalRoutineOccurrenceStatus,
  PersonalRoutineSchedule,
  PersonalRoutinesError,
  PersonalTaskId,
  type PersonalRoutine,
  type PersonalRoutineCreateInput,
  type PersonalRoutineListResult,
  type PersonalRoutineOccurrence,
  type PersonalRoutineRunNowInput,
  type PersonalRoutineRunNowResult,
  type PersonalRoutineUpdateInput,
  type PersonalTask,
} from "@t3tools/contracts";

import { forkParked } from "../../serverActivation.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import { dueRoutineSlots, nextRoutineSlot, type RoutineSlot } from "./routineSchedule.ts";
import { isValidTimeZone, parseLocal } from "./zonedTime.ts";

/** A slot this late (or less) counts as on time and always runs, whatever the policy. */
export const PERSONAL_ROUTINE_MISSED_GRACE_MS = 2 * 60_000;
const TICK_INTERVAL = "30 seconds";

const RoutineDbRow = Schema.Struct({
  routineId: PersonalRoutineId,
  botId: PersonalBotId,
  title: Schema.String,
  prompt: Schema.String,
  schedule: Schema.fromJsonString(PersonalRoutineSchedule),
  timeZone: Schema.String,
  enabled: Schema.Number,
  missedPolicy: PersonalRoutineMissedPolicy,
  nextDueAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  lastOccurrenceLocal: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});

const OccurrenceDbRow = Schema.Struct({
  routineId: PersonalRoutineId,
  localOccurrence: Schema.String,
  dueAt: Schema.DateTimeUtcFromString,
  taskId: Schema.NullOr(PersonalTaskId),
  status: PersonalRoutineOccurrenceStatus,
  errorMessage: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
});

const decodeRoutineRow = Schema.decodeUnknownEffect(RoutineDbRow);
const decodeOccurrenceRow = Schema.decodeUnknownEffect(OccurrenceDbRow);

const ROUTINE_COLUMNS = `
  routine_id AS "routineId",
  bot_id AS "botId",
  title AS "title",
  prompt AS "prompt",
  schedule_json AS "schedule",
  time_zone AS "timeZone",
  enabled AS "enabled",
  missed_policy AS "missedPolicy",
  next_due_utc AS "nextDueAt",
  last_occurrence_local AS "lastOccurrenceLocal",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

/** Occurrence rows older than this are pruned each tick; the list window is shorter. */
const OCCURRENCE_RETENTION_DAYS = 180;
const OCCURRENCE_LIST_WINDOW_DAYS = 30;
const OCCURRENCE_COLUMNS = `
  routine_id AS "routineId",
  local_occurrence AS "localOccurrence",
  due_utc AS "dueAt",
  task_id AS "taskId",
  status AS "status",
  error_message AS "errorMessage",
  created_at AS "createdAt"
`;

const encodeSchedule = Schema.encodeSync(Schema.fromJsonString(PersonalRoutineSchedule));
const isRoutinesError = Schema.is(PersonalRoutinesError);

// @effect-diagnostics-next-line globalDate:off - slot instants are epoch millis from wall-clock arithmetic.
const isoOfMs = (ms: number) => new Date(ms).toISOString();

/** Idempotency key of the task an occurrence starts: one task per slot, ever. */
export const routineTaskIdempotencyKey = (routineId: string, localOccurrence: string) =>
  `routine:${routineId}:${localOccurrence}`;

export class PersonalRoutineService extends Context.Service<
  PersonalRoutineService,
  {
    readonly list: () => Effect.Effect<PersonalRoutineListResult, PersonalRoutinesError>;
    readonly get: (input: {
      readonly routineId: PersonalRoutineId;
    }) => Effect.Effect<PersonalRoutine, PersonalRoutinesError>;
    readonly create: (
      input: PersonalRoutineCreateInput,
    ) => Effect.Effect<PersonalRoutine, PersonalRoutinesError>;
    readonly update: (
      input: PersonalRoutineUpdateInput,
    ) => Effect.Effect<PersonalRoutine, PersonalRoutinesError>;
    readonly remove: (input: {
      readonly routineId: PersonalRoutineId;
    }) => Effect.Effect<void, PersonalRoutinesError>;
    readonly pause: (input: {
      readonly routineId: PersonalRoutineId;
    }) => Effect.Effect<PersonalRoutine, PersonalRoutinesError>;
    readonly resume: (input: {
      readonly routineId: PersonalRoutineId;
    }) => Effect.Effect<PersonalRoutine, PersonalRoutinesError>;
    readonly runNow: (
      input: PersonalRoutineRunNowInput,
    ) => Effect.Effect<PersonalRoutineRunNowResult, PersonalRoutinesError>;
    /** One catch-up pass over every enabled routine that is due. */
    readonly tick: Effect.Effect<void>;
    /** Runs `tick` now (startup catch-up) and then every 30 seconds. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/personal/routines/PersonalRoutineService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* PersonalTaskService.PersonalTaskService;
  const bots = yield* PersonalBotRepository.PersonalBotRepository;
  // Serialises ticks with mutations so an edit never races a firing.
  const lock = yield* Semaphore.make(1);

  const fail = (message: string, cause?: unknown) =>
    new PersonalRoutinesError({ message, ...(cause === undefined ? {} : { cause }) });

  const storageFailure =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, PersonalRoutinesError, R> =>
      effect.pipe(
        Effect.mapError((cause) =>
          isRoutinesError(cause) ? cause : fail(`Personal routines ${operation} failed.`, cause),
        ),
      );

  const toRoutine = (row: typeof RoutineDbRow.Type): PersonalRoutine => ({
    ...row,
    enabled: row.enabled === 1,
  });

  const readRoutine = (routineId: PersonalRoutineId) =>
    sql`SELECT ${sql.literal(ROUTINE_COLUMNS)} FROM personal_routines WHERE routine_id = ${routineId}`.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(Option.none<PersonalRoutine>())
          : decodeRoutineRow(rows[0]).pipe(Effect.map((row) => Option.some(toRoutine(row)))),
      ),
    );

  const requireRoutine = (routineId: PersonalRoutineId) =>
    readRoutine(routineId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail(`Routine '${routineId}' was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const readOccurrence = (routineId: PersonalRoutineId, localOccurrence: string) =>
    sql`
      SELECT ${sql.literal(OCCURRENCE_COLUMNS)} FROM personal_routine_occurrences
      WHERE routine_id = ${routineId} AND local_occurrence = ${localOccurrence}
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(Option.none<PersonalRoutineOccurrence>())
          : decodeOccurrenceRow(rows[0]).pipe(Effect.map(Option.some)),
      ),
    );

  const requireLiveBot = (botId: PersonalBotId) =>
    bots
      .listBots()
      .pipe(
        Effect.flatMap((live) =>
          live.some((bot) => bot.botId === botId)
            ? Effect.void
            : Effect.fail(fail(`Personal bot '${botId}' was not found.`)),
        ),
      );

  /** Validates the schedule and fills server-owned fields (interval anchor). */
  const normalizeSchedule = (schedule: PersonalRoutineSchedule, nowMs: number) => {
    switch (schedule.kind) {
      case "daily":
        return Effect.succeed(schedule);
      case "weekly":
        return Effect.succeed({
          ...schedule,
          days: [...new Set(schedule.days)].toSorted((left, right) => left - right),
        });
      case "interval": {
        const anchorAt = schedule.anchorAt ?? isoOfMs(nowMs);
        return Number.isFinite(Date.parse(anchorAt))
          ? Effect.succeed({ ...schedule, anchorAt })
          : Effect.fail(fail("The interval start time is not a valid instant."));
      }
      case "once":
        return parseLocal(schedule.at) === null
          ? Effect.fail(fail(`'${schedule.at}' is not a real date and time.`))
          : Effect.succeed(schedule);
    }
  };

  const requireTimeZone = (timeZone: string) =>
    isValidTimeZone(timeZone)
      ? Effect.succeed(timeZone)
      : Effect.fail(fail(`'${timeZone}' is not a known IANA time zone.`));

  // Records the slot and, unless skipped, starts its task. Safe to repeat:
  // the occurrence row dedupes the slot and the task idempotency key dedupes
  // the task, so a crash between the two is completed on the next pass.
  const fireSlot = Effect.fn("PersonalRoutineService.fireSlot")(function* (
    routine: PersonalRoutine,
    slot: RoutineSlot,
    mode: "run" | "skip",
  ) {
    const now = yield* DateTime.now;
    yield* sql`
      INSERT INTO personal_routine_occurrences (
        routine_id, local_occurrence, due_utc, task_id, status, error_message, created_at
      )
      VALUES (
        ${routine.routineId}, ${slot.localKey}, ${isoOfMs(slot.dueMs)}, NULL,
        ${mode === "skip" ? "skipped" : "created"}, NULL, ${DateTime.formatIso(now)}
      )
      ON CONFLICT (routine_id, local_occurrence) DO NOTHING
    `;
    const occurrence = yield* readOccurrence(routine.routineId, slot.localKey);
    if (
      Option.isNone(occurrence) ||
      occurrence.value.status !== "created" ||
      occurrence.value.taskId !== null
    ) {
      return null;
    }
    const created = yield* tasks
      .createTask({
        idempotencyKey: routineTaskIdempotencyKey(routine.routineId, slot.localKey),
        botId: routine.botId,
        title: routine.title,
        objective: routine.prompt,
        source: "routine",
      })
      .pipe(Effect.result);
    if (created._tag === "Failure") {
      yield* sql`
        UPDATE personal_routine_occurrences
        SET status = 'failed', error_message = ${created.failure.message}
        WHERE routine_id = ${routine.routineId} AND local_occurrence = ${slot.localKey}
      `;
      return yield* fail(created.failure.message, created.failure);
    }
    yield* sql`
      UPDATE personal_routine_occurrences
      SET task_id = ${created.success.taskId}
      WHERE routine_id = ${routine.routineId} AND local_occurrence = ${slot.localKey}
    `;
    return created.success;
  });

  const advance = (
    routine: PersonalRoutine,
    nextDueMs: number | null,
    firedKey: string | null,
    nowIso: string,
  ) =>
    sql`
      UPDATE personal_routines
      SET next_due_utc = ${nextDueMs === null ? null : isoOfMs(nextDueMs)},
          last_occurrence_local = COALESCE(${firedKey}, last_occurrence_local),
          updated_at = ${nowIso}
      WHERE routine_id = ${routine.routineId}
    `;

  // Occurrences and their tasks are history, not children of the schedule.
  // Keeping this as the one deletion path makes manual and automatic removal
  // agree while the existing retention pass eventually prunes old occurrences.
  const deleteRoutine = (routineId: PersonalRoutineId) =>
    sql`DELETE FROM personal_routines WHERE routine_id = ${routineId}`.pipe(Effect.asVoid);

  // Missed runs (the laptop slept): an on-time slot always runs; otherwise
  // `coalesce` runs ONE occurrence for the latest missed slot and `skip`
  // records it as skipped. Either way the routine advances past `now`.
  const catchUpRoutine = Effect.fn("PersonalRoutineService.catchUpRoutine")(function* (
    routine: PersonalRoutine,
    nowMs: number,
    nowIso: string,
  ) {
    const next = nextRoutineSlot(routine.schedule, routine.timeZone, nowMs);
    if (routine.nextDueAt === null) {
      if (next === null) {
        yield* deleteRoutine(routine.routineId);
      } else {
        yield* advance(routine, next.dueMs, null, nowIso);
      }
      return;
    }
    const due = dueRoutineSlots(
      routine.schedule,
      routine.timeZone,
      DateTime.toEpochMillis(routine.nextDueAt),
      nowMs,
    );
    if (due === null) {
      if (next === null) {
        yield* deleteRoutine(routine.routineId);
      } else {
        yield* advance(routine, next.dueMs, null, nowIso);
      }
      return;
    }
    const onTime = nowMs - due.latest.dueMs <= PERSONAL_ROUTINE_MISSED_GRACE_MS;
    const mode = onTime || routine.missedPolicy === "coalesce" ? "run" : "skip";
    yield* fireSlot(routine, due.latest, mode).pipe(
      Effect.catch((error) =>
        Effect.logWarning("personal routine could not start its task", {
          routineId: routine.routineId,
          slot: due.latest.localKey,
          error: error.message,
        }),
      ),
    );
    if (next === null) {
      yield* deleteRoutine(routine.routineId);
    } else {
      yield* advance(routine, next.dueMs, mode === "run" ? due.latest.localKey : null, nowIso);
    }
  });

  const tick: PersonalRoutineService["Service"]["tick"] = lock
    .withPermit(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const nowIso = DateTime.formatIso(now);
        // The occurrence table is the dedupe guard for recent slots only; a
        // slot this old can never be recomputed as due, so its row is dead
        // weight. One bounded DELETE per tick keeps the table small.
        const pruneBefore = DateTime.formatIso(
          DateTime.subtract(now, { days: OCCURRENCE_RETENTION_DAYS }),
        );
        yield* sql`
          DELETE FROM personal_routine_occurrences
          WHERE created_at < ${pruneBefore}
        `;
        const rows = yield* sql`
          SELECT ${sql.literal(ROUTINE_COLUMNS)} FROM personal_routines
          WHERE next_due_utc IS NULL
             OR (enabled = 1 AND next_due_utc <= ${nowIso})
          ORDER BY next_due_utc ASC
        `;
        for (const raw of rows) {
          const routine = toRoutine(yield* decodeRoutineRow(raw));
          yield* catchUpRoutine(routine, DateTime.toEpochMillis(now), nowIso);
        }
      }),
    )
    .pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal routines tick failed", { cause: Cause.pretty(cause) }),
      ),
    );

  const list: PersonalRoutineService["Service"]["list"] = () =>
    Effect.gen(function* () {
      const routineRows = yield* sql`
        SELECT ${sql.literal(ROUTINE_COLUMNS)} FROM personal_routines
        ORDER BY created_at ASC, routine_id ASC
      `;
      // The window function ranks only recent rows (indexed on routine_id,
      // created_at); the list shows the last 10 per routine anyway.
      const since = DateTime.formatIso(
        DateTime.subtract(yield* DateTime.now, { days: OCCURRENCE_LIST_WINDOW_DAYS }),
      );
      const occurrenceRows = yield* sql`
        SELECT ${sql.literal(OCCURRENCE_COLUMNS)} FROM (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY routine_id ORDER BY created_at DESC, local_occurrence DESC
          ) AS position
          FROM personal_routine_occurrences
          WHERE created_at >= ${since}
        )
        WHERE position <= 10
        ORDER BY created_at DESC, local_occurrence DESC
      `;
      const routines = yield* Effect.forEach(routineRows, (row) =>
        decodeRoutineRow(row).pipe(Effect.map(toRoutine)),
      );
      const occurrences = yield* Effect.forEach(occurrenceRows, (row) => decodeOccurrenceRow(row));
      return { routines, occurrences } satisfies PersonalRoutineListResult;
    }).pipe(storageFailure("list"));

  const get: PersonalRoutineService["Service"]["get"] = (input) =>
    requireRoutine(input.routineId).pipe(storageFailure("get"));

  const create: PersonalRoutineService["Service"]["create"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const existing = yield* readRoutine(input.routineId);
          if (Option.isSome(existing)) return existing.value;
          yield* requireLiveBot(input.botId);
          const timeZone = yield* requireTimeZone(
            input.timeZone ?? PERSONAL_ROUTINE_DEFAULT_TIME_ZONE,
          );
          const now = yield* DateTime.now;
          const nowMs = DateTime.toEpochMillis(now);
          const schedule = yield* normalizeSchedule(input.schedule, nowMs);
          const next = nextRoutineSlot(schedule, timeZone, nowMs);
          if (next === null) {
            return yield* fail(`That time has already passed in ${timeZone}.`);
          }
          const nowIso = DateTime.formatIso(now);
          yield* sql`
            INSERT INTO personal_routines (
              routine_id, bot_id, title, prompt, schedule_json, time_zone, enabled,
              missed_policy, next_due_utc, last_occurrence_local, created_at, updated_at
            )
            VALUES (
              ${input.routineId}, ${input.botId}, ${input.title}, ${input.prompt},
              ${encodeSchedule(schedule)}, ${timeZone}, 1, ${input.missedPolicy ?? "coalesce"},
              ${isoOfMs(next.dueMs)}, NULL, ${nowIso}, ${nowIso}
            )
            ON CONFLICT (routine_id) DO NOTHING
          `;
          return yield* requireRoutine(input.routineId);
        }),
      )
      .pipe(storageFailure("create"));

  const update: PersonalRoutineService["Service"]["update"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const current = yield* requireRoutine(input.routineId);
          if (input.botId !== undefined) yield* requireLiveBot(input.botId);
          const timeZone = yield* requireTimeZone(input.timeZone ?? current.timeZone);
          const now = yield* DateTime.now;
          const nowMs = DateTime.toEpochMillis(now);
          const scheduleChanged = input.schedule !== undefined || timeZone !== current.timeZone;
          const schedule =
            input.schedule === undefined
              ? current.schedule
              : yield* normalizeSchedule(input.schedule, nowMs);
          let nextDueAt = current.nextDueAt === null ? null : DateTime.formatIso(current.nextDueAt);
          if (scheduleChanged) {
            const next = nextRoutineSlot(schedule, timeZone, nowMs);
            if (next === null && current.enabled) {
              return yield* fail(`That time has already passed in ${timeZone}.`);
            }
            nextDueAt = next === null ? null : isoOfMs(next.dueMs);
          }
          yield* sql`
            UPDATE personal_routines
            SET bot_id = ${input.botId ?? current.botId},
                title = ${input.title ?? current.title},
                prompt = ${input.prompt ?? current.prompt},
                schedule_json = ${encodeSchedule(schedule)},
                time_zone = ${timeZone},
                missed_policy = ${input.missedPolicy ?? current.missedPolicy},
                next_due_utc = ${nextDueAt},
                updated_at = ${DateTime.formatIso(now)}
            WHERE routine_id = ${input.routineId}
          `;
          return yield* requireRoutine(input.routineId);
        }),
      )
      .pipe(storageFailure("update"));

  const remove: PersonalRoutineService["Service"]["remove"] = (input) =>
    lock.withPermit(deleteRoutine(input.routineId)).pipe(storageFailure("delete"));

  const pause: PersonalRoutineService["Service"]["pause"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          yield* requireRoutine(input.routineId);
          const nowIso = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            UPDATE personal_routines SET enabled = 0, updated_at = ${nowIso}
            WHERE routine_id = ${input.routineId}
          `;
          return yield* requireRoutine(input.routineId);
        }),
      )
      .pipe(storageFailure("pause"));

  // Resuming never replays what was due while paused: the next slot after now.
  const resume: PersonalRoutineService["Service"]["resume"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const current = yield* requireRoutine(input.routineId);
          const now = yield* DateTime.now;
          const next = nextRoutineSlot(
            current.schedule,
            current.timeZone,
            DateTime.toEpochMillis(now),
          );
          if (next === null) {
            yield* deleteRoutine(current.routineId);
            return yield* fail(`Routine '${input.routineId}' was not found.`);
          }
          const nowIso = DateTime.formatIso(now);
          yield* sql`
            UPDATE personal_routines
            SET enabled = 1,
                next_due_utc = ${isoOfMs(next.dueMs)},
                updated_at = ${nowIso}
            WHERE routine_id = ${input.routineId}
          `;
          return yield* requireRoutine(input.routineId);
        }),
      )
      .pipe(storageFailure("resume"));

  // A manual run is its own occurrence (`manual:<request>`), so it never
  // collides with, consumes or advances a scheduled slot.
  const runNow: PersonalRoutineService["Service"]["runNow"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const routine = yield* requireRoutine(input.routineId);
          const now = yield* DateTime.now;
          const nowMs = DateTime.toEpochMillis(now);
          const localKey = `manual:${input.requestId ?? isoOfMs(nowMs)}`;
          const task: PersonalTask | null = yield* fireSlot(
            routine,
            { localKey, dueMs: nowMs },
            "run",
          );
          const settled =
            task ??
            (yield* tasks
              .list({})
              .pipe(
                Effect.map((result) =>
                  result.tasks.find(
                    (entry) =>
                      entry.idempotencyKey ===
                      routineTaskIdempotencyKey(routine.routineId, localKey),
                  ),
                ),
              ));
          if (settled === undefined) {
            return yield* fail("The routine run could not be started.");
          }
          return { routine, task: settled } satisfies PersonalRoutineRunNowResult;
        }),
      )
      .pipe(storageFailure("run"));

  const start: PersonalRoutineService["Service"]["start"] = () =>
    forkParked(tick.pipe(Effect.repeat(Schedule.spaced(TICK_INTERVAL)), Effect.asVoid)).pipe(
      Effect.asVoid,
    );

  return {
    list,
    get,
    create,
    update,
    remove,
    pause,
    resume,
    runNow,
    tick,
    start,
  } satisfies PersonalRoutineService["Service"];
});

export const layer = Layer.effect(PersonalRoutineService, make);
