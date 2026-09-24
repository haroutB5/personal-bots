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

import * as NodeCrypto from "node:crypto";

import {
  PERSONAL_ROUTINE_DEFAULT_TIME_ZONE,
  PERSONAL_ROUTINE_EVENT_MIN_INTERVAL_MS,
  PERSONAL_ROUTINE_HOOK_TOKEN_BYTES,
  PERSONAL_ROUTINE_HOOK_TOKEN_PATTERN,
  PersonalBotId,
  PersonalRoutineDelivery,
  PersonalRoutineId,
  PersonalRoutineMissedPolicy,
  PersonalRoutineOccurrenceStatus,
  PersonalRoutineSchedule,
  PersonalRoutinesError,
  PersonalRoutineTrigger,
  PersonalTaskId,
  personalRoutineRelayMessage,
  type PersonalRoutine,
  type PersonalRoutineCreateInput,
  type PersonalRoutineListResult,
  type PersonalRoutineOccurrence,
  type PersonalRoutineRunNowInput,
  type PersonalRoutineRunNowResult,
  type PersonalRoutineUpdateInput,
  type PersonalTask,
  type PersonalTasksError,
} from "@t3tools/contracts";

import { timingSafeEqualBase64Url } from "../../auth/utils.ts";
import { forkParked } from "../../serverActivation.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import { buildEventRoutinePrompt, formatHookPayload } from "./eventPrompt.ts";
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
  trigger: PersonalRoutineTrigger,
  // Event routines store the JSON literal `null`; see migration 064.
  schedule: Schema.fromJsonString(Schema.NullOr(PersonalRoutineSchedule)),
  eventLabel: Schema.NullOr(Schema.String),
  hookToken: Schema.NullOr(Schema.String),
  lastFiredAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  timeZone: Schema.String,
  enabled: Schema.Number,
  missedPolicy: PersonalRoutineMissedPolicy,
  delivery: PersonalRoutineDelivery,
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
  trigger_kind AS "trigger",
  schedule_json AS "schedule",
  event_label AS "eventLabel",
  hook_token AS "hookToken",
  last_fired_utc AS "lastFiredAt",
  time_zone AS "timeZone",
  enabled AS "enabled",
  missed_policy AS "missedPolicy",
  delivery AS "delivery",
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

const encodeSchedule = Schema.encodeSync(
  Schema.fromJsonString(Schema.NullOr(PersonalRoutineSchedule)),
);
const isRoutinesError = Schema.is(PersonalRoutinesError);

/** 32 random bytes, base64url: 256 bits of entropy in a 43-character URL segment. */
const makeHookToken = () =>
  NodeCrypto.randomBytes(PERSONAL_ROUTINE_HOOK_TOKEN_BYTES).toString("base64url");

// @effect-diagnostics-next-line globalDate:off - slot instants are epoch millis from wall-clock arithmetic.
const isoOfMs = (ms: number) => new Date(ms).toISOString();

/** Idempotency key of the task an occurrence starts: one task per slot, ever. */
export const routineTaskIdempotencyKey = (routineId: string, localOccurrence: string) =>
  `routine:${routineId}:${localOccurrence}`;

export interface PersonalRoutineFireEventInput {
  readonly hookToken: string;
  readonly contentType: string | null;
  readonly body: string;
}

/**
 * What a routine's preparer decided for one run: start it with this objective
 * (the routine's prompt plus whatever run data the owner adds), or skip the
 * slot with a reason. `onStarted` runs once the task exists, for state that
 * must only be recorded when a run really started.
 */
export type PersonalRoutinePrepared =
  | {
      readonly _tag: "Run";
      readonly objective: string;
      readonly onStarted?: (task: PersonalTask) => Effect.Effect<void>;
    }
  | { readonly _tag: "Skip"; readonly reason: string };

/**
 * A server module that owns a routine can prepare each of its model runs just
 * before the task starts: decide whether there is anything to do at all, and
 * add run data to the objective. Preparers are registered in memory at start-up
 * (see `registerPreparer`); a routine without one runs its prompt as written.
 * A preparer runs under the routine lock, so it must not call this service.
 */
export type PersonalRoutinePreparer = (input: {
  readonly routine: PersonalRoutine;
  readonly localOccurrence: string;
  /** Run now from the app, as opposed to a scheduled slot. */
  readonly manual: boolean;
}) => Effect.Effect<PersonalRoutinePrepared>;

export type PersonalRoutineFireEventResult =
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "RateLimited"; readonly retryAfterSeconds: number }
  | { readonly _tag: "Fired"; readonly taskId: PersonalTaskId }
  | { readonly _tag: "Failed" };

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
    /**
     * Webhook entry point. Never fails and never reports which routine (or
     * whether any) owns a token beyond found/not-found, because the caller is
     * an unauthenticated external service.
     */
    readonly fireEvent: (
      input: PersonalRoutineFireEventInput,
    ) => Effect.Effect<PersonalRoutineFireEventResult>;
    /** Mints a new hook token; the previous webhook URL stops working at once. */
    readonly regenerateHook: (input: {
      readonly routineId: PersonalRoutineId;
    }) => Effect.Effect<PersonalRoutine, PersonalRoutinesError>;
    /** Sets (or replaces) the preparer of one routine's model runs. */
    readonly registerPreparer: (
      routineId: PersonalRoutineId,
      preparer: PersonalRoutinePreparer,
    ) => Effect.Effect<void>;
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
  const preparers = new Map<string, PersonalRoutinePreparer>();

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
  //
  // A relay routine starts no turn: its text goes into the bot's chat as the
  // bot's message, recorded as an already-completed task. `relayText` is
  // what an event delivered (null: the payload had nothing to relay); left
  // out, a relay posts the routine's own prompt.
  const fireSlot = Effect.fn("PersonalRoutineService.fireSlot")(function* (
    routine: PersonalRoutine,
    slot: RoutineSlot,
    mode: "run" | "skip",
    relayText?: string | null,
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
    const idempotencyKey = routineTaskIdempotencyKey(routine.routineId, slot.localKey);
    const relay = routine.delivery === "relay";
    const text = relayText === undefined ? routine.prompt : relayText;
    const preparer = relay ? undefined : preparers.get(routine.routineId);
    let objective = routine.prompt;
    let onStarted: ((task: PersonalTask) => Effect.Effect<void>) | undefined;
    if (preparer !== undefined) {
      const prepared = yield* Effect.suspend(() =>
        preparer({
          routine,
          localOccurrence: slot.localKey,
          manual: slot.localKey.startsWith("manual:"),
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed({
            _tag: "Failed" as const,
            message: `The routine could not prepare its run: ${Cause.pretty(cause).split("\n")[0] ?? "unknown error"}`,
          }),
        ),
      );
      if (prepared._tag === "Failed") {
        yield* sql`
          UPDATE personal_routine_occurrences
          SET status = 'failed', error_message = ${prepared.message}
          WHERE routine_id = ${routine.routineId} AND local_occurrence = ${slot.localKey}
        `;
        return yield* fail(prepared.message);
      }
      if (prepared._tag === "Skip") {
        // Nothing to do this time: the slot is used up quietly, with the
        // reason on record for the Scheduled list.
        yield* sql`
          UPDATE personal_routine_occurrences
          SET status = 'skipped', error_message = ${prepared.reason}
          WHERE routine_id = ${routine.routineId} AND local_occurrence = ${slot.localKey}
        `;
        return null;
      }
      objective = prepared.objective;
      onStarted = prepared.onStarted;
    }
    const start: Effect.Effect<PersonalTask, PersonalRoutinesError | PersonalTasksError> = !relay
      ? tasks.createTask({
          idempotencyKey,
          botId: routine.botId,
          title: routine.title,
          objective,
          source: "routine",
        })
      : text === null
        ? Effect.fail(
            fail(
              "The event had no 'message' text to relay. Send a JSON or form body with a message field.",
            ),
          )
        : tasks.relay({
            idempotencyKey,
            botId: routine.botId,
            title: routine.title,
            text,
            source: "routine",
          });
    const created = yield* Effect.result(start);
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
    if (onStarted !== undefined) {
      yield* onStarted(created.success).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("personal routine preparer could not record its started run", {
            routineId: routine.routineId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
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
    // Event routines never appear in the sweep; they have no slots to miss and
    // no exhaustion to be deleted for. Belt and braces with the tick's filter.
    if (routine.schedule === null) return;
    const schedule = routine.schedule;
    const next = nextRoutineSlot(schedule, routine.timeZone, nowMs);
    if (routine.nextDueAt === null) {
      if (next === null) {
        yield* deleteRoutine(routine.routineId);
      } else {
        yield* advance(routine, next.dueMs, null, nowIso);
      }
      return;
    }
    const due = dueRoutineSlots(
      schedule,
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
        // `trigger_kind` first: an event routine has next_due_utc NULL forever,
        // and the NULL branch is what deletes an exhausted schedule. Without
        // this filter every event routine would be swept away on the next tick.
        const rows = yield* sql`
          SELECT ${sql.literal(ROUTINE_COLUMNS)} FROM personal_routines
          WHERE trigger_kind = 'schedule'
            AND (next_due_utc IS NULL OR (enabled = 1 AND next_due_utc <= ${nowIso}))
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
          const trigger = input.trigger ?? "schedule";
          const eventLabel = input.eventLabel?.trim() ?? "";
          // Both halves submitted: one of them would have to be thrown away, and
          // the caller would never learn which. Refuse instead of choosing.
          if (input.schedule !== undefined && eventLabel.length > 0) {
            return yield* fail(
              "A routine runs on a schedule or on an event, not both. Remove whichever one you did not mean.",
            );
          }
          yield* requireLiveBot(input.botId);
          const timeZone = yield* requireTimeZone(
            input.timeZone ?? PERSONAL_ROUTINE_DEFAULT_TIME_ZONE,
          );
          const now = yield* DateTime.now;
          const nowMs = DateTime.toEpochMillis(now);
          const nowIso = DateTime.formatIso(now);
          if (trigger === "event") {
            if (eventLabel.length === 0) {
              return yield* fail("Give the event a name, for example 'PR merged'.");
            }
            yield* sql`
              INSERT INTO personal_routines (
                routine_id, bot_id, title, prompt, trigger_kind, schedule_json, event_label,
                hook_token, last_fired_utc, time_zone, enabled, missed_policy, delivery,
                next_due_utc, last_occurrence_local, created_at, updated_at
              )
              VALUES (
                ${input.routineId}, ${input.botId}, ${input.title}, ${input.prompt}, 'event',
                ${encodeSchedule(null)}, ${eventLabel}, ${makeHookToken()}, NULL, ${timeZone},
                1, ${input.missedPolicy ?? "coalesce"}, ${input.delivery ?? "model"}, NULL, NULL,
                ${nowIso}, ${nowIso}
              )
              ON CONFLICT (routine_id) DO NOTHING
            `;
            return yield* requireRoutine(input.routineId);
          }
          if (input.schedule === undefined) {
            return yield* fail("A scheduled routine needs a schedule.");
          }
          const schedule = yield* normalizeSchedule(input.schedule, nowMs);
          const next = nextRoutineSlot(schedule, timeZone, nowMs);
          if (next === null) {
            return yield* fail(`That time has already passed in ${timeZone}.`);
          }
          yield* sql`
            INSERT INTO personal_routines (
              routine_id, bot_id, title, prompt, trigger_kind, schedule_json, time_zone, enabled,
              missed_policy, delivery, next_due_utc, last_occurrence_local, created_at, updated_at
            )
            VALUES (
              ${input.routineId}, ${input.botId}, ${input.title}, ${input.prompt}, 'schedule',
              ${encodeSchedule(schedule)}, ${timeZone}, 1, ${input.missedPolicy ?? "coalesce"},
              ${input.delivery ?? "model"}, ${isoOfMs(next.dueMs)}, NULL, ${nowIso}, ${nowIso}
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
          // The trigger is fixed at creation, so an edit only ever touches the
          // half of the shape the routine actually has.
          if (current.trigger === "event") {
            const eventLabel = input.eventLabel?.trim() ?? current.eventLabel ?? "";
            if (eventLabel.length === 0) {
              return yield* fail("Give the event a name, for example 'PR merged'.");
            }
            yield* sql`
              UPDATE personal_routines
              SET bot_id = ${input.botId ?? current.botId},
                  title = ${input.title ?? current.title},
                  prompt = ${input.prompt ?? current.prompt},
                  event_label = ${eventLabel},
                  time_zone = ${timeZone},
                  delivery = ${input.delivery ?? current.delivery ?? "model"},
                  updated_at = ${DateTime.formatIso(now)}
              WHERE routine_id = ${input.routineId}
            `;
            return yield* requireRoutine(input.routineId);
          }
          const scheduleChanged = input.schedule !== undefined || timeZone !== current.timeZone;
          const schedule =
            input.schedule === undefined
              ? current.schedule
              : yield* normalizeSchedule(input.schedule, nowMs);
          if (schedule === null) {
            return yield* fail("A scheduled routine needs a schedule.");
          }
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
                delivery = ${input.delivery ?? current.delivery ?? "model"},
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
          // An event routine has nothing to recompute: it simply starts
          // accepting its webhook again.
          if (current.schedule === null) {
            const resumedAt = DateTime.formatIso(now);
            yield* sql`
              UPDATE personal_routines SET enabled = 1, updated_at = ${resumedAt}
              WHERE routine_id = ${input.routineId}
            `;
            return yield* requireRoutine(input.routineId);
          }
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
            const occurrence = yield* readOccurrence(routine.routineId, localKey);
            if (Option.isSome(occurrence) && occurrence.value.status === "skipped") {
              return yield* fail(
                `Nothing to run: ${occurrence.value.errorMessage ?? "the routine skipped this run"}.`,
              );
            }
            return yield* fail("The routine run could not be started.");
          }
          return { routine, task: settled } satisfies PersonalRoutineRunNowResult;
        }),
      )
      .pipe(storageFailure("run"));

  /**
   * Resolves a hook token without letting the comparison leak it. The lookup is
   * NOT `WHERE hook_token = ?`: SQLite's string compare exits at the first
   * differing byte, so a remote caller could walk the token out one character
   * at a time. Instead every enabled event routine's token is compared with a
   * constant-time equality over the whole 32 bytes. The set is a handful of
   * rows (one per event routine the user created), so the scan is free.
   */
  const resolveHookToken = (hookToken: string) =>
    Effect.gen(function* () {
      if (!PERSONAL_ROUTINE_HOOK_TOKEN_PATTERN.test(hookToken)) return null;
      const rows = yield* sql`
        SELECT ${sql.literal(ROUTINE_COLUMNS)} FROM personal_routines
        WHERE trigger_kind = 'event' AND hook_token IS NOT NULL
      `;
      let found: PersonalRoutine | null = null;
      for (const raw of rows) {
        const routine = toRoutine(yield* decodeRoutineRow(raw));
        if (routine.hookToken !== null && timingSafeEqualBase64Url(routine.hookToken, hookToken)) {
          found = routine;
        }
      }
      return found;
    });

  const fireEvent: PersonalRoutineService["Service"]["fireEvent"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const routine = yield* resolveHookToken(input.hookToken);
          // A paused routine is indistinguishable from an unknown token on the
          // wire: the caller is unauthenticated and learns nothing either way.
          if (routine === null || !routine.enabled) {
            return { _tag: "NotFound" } as const;
          }
          const now = yield* DateTime.now;
          const nowMs = DateTime.toEpochMillis(now);
          if (routine.lastFiredAt !== null) {
            const sinceMs = nowMs - DateTime.toEpochMillis(routine.lastFiredAt);
            if (sinceMs < PERSONAL_ROUTINE_EVENT_MIN_INTERVAL_MS) {
              return {
                _tag: "RateLimited",
                retryAfterSeconds: Math.max(
                  1,
                  Math.ceil((PERSONAL_ROUTINE_EVENT_MIN_INTERVAL_MS - sinceMs) / 1000),
                ),
              } as const;
            }
          }
          const nowIso = DateTime.formatIso(now);
          // Stamp before firing: a crash mid-run must not open the rate limit.
          yield* sql`
            UPDATE personal_routines SET last_fired_utc = ${nowIso}, updated_at = ${nowIso}
            WHERE routine_id = ${routine.routineId}
          `;
          const slot = { localKey: `event:${nowIso}`, dueMs: nowMs };
          // Each accepted delivery gets a distinct occurrence. Retries outside
          // the rate-limit window are new runs; no delivery ID is supplied.
          const task =
            routine.delivery === "relay"
              ? yield* fireSlot(
                  routine,
                  slot,
                  "run",
                  personalRoutineRelayMessage(input.contentType, input.body),
                )
              : yield* fireSlot(
                  {
                    ...routine,
                    prompt: buildEventRoutinePrompt({
                      prompt: routine.prompt,
                      eventLabel: routine.eventLabel ?? "event",
                      payload: formatHookPayload(input.contentType, input.body),
                    }),
                  },
                  slot,
                  "run",
                );
          return task === null
            ? ({ _tag: "Failed" } as const)
            : ({ _tag: "Fired", taskId: task.taskId } as const);
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("personal routine webhook could not fire", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ _tag: "Failed" } as const)),
        ),
      );

  const regenerateHook: PersonalRoutineService["Service"]["regenerateHook"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const current = yield* requireRoutine(input.routineId);
          if (current.trigger !== "event") {
            return yield* fail("Only event routines have a webhook URL.");
          }
          const nowIso = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            UPDATE personal_routines
            SET hook_token = ${makeHookToken()}, updated_at = ${nowIso}
            WHERE routine_id = ${input.routineId}
          `;
          return yield* requireRoutine(input.routineId);
        }),
      )
      .pipe(storageFailure("regenerate hook"));

  const registerPreparer: PersonalRoutineService["Service"]["registerPreparer"] = (
    routineId,
    preparer,
  ) => Effect.sync(() => void preparers.set(routineId, preparer));

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
    fireEvent,
    regenerateHook,
    registerPreparer,
    tick,
    start,
  } satisfies PersonalRoutineService["Service"];
});

export const layer = Layer.effect(PersonalRoutineService, make);
