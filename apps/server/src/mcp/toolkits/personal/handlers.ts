import * as NodeCrypto from "node:crypto";

import {
  describePersonalRoutineTrigger,
  PersonalRoutineId,
  type PersonalRoutineSchedule,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as PersonalBotRepository from "../../../personal/PersonalBotRepository.ts";
import * as PersonalMemoryService from "../../../personal/memory/PersonalMemoryService.ts";
import * as PersonalRoutineService from "../../../personal/routines/PersonalRoutineService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CreateRoutineInput, PersonalToolError, PersonalToolkit } from "./tools.ts";

const encodeCreateRoutineInput = Schema.encodeSync(Schema.fromJsonString(CreateRoutineInput));

const WEEKDAY_NUMBER = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
} as const;

/** save_memory only runs on an explicit ask from the user. */
export const EXPLICIT_REMEMBER_REQUEST =
  /\b(remember|memori[sz]e|don'?t forget|do not forget|keep in mind|save (this|that|it)|note (this|that|it) down|for future reference)\b/i;

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Maps the tool's natural fields onto a routine schedule, or explains what is missing. */
export function routineScheduleFromToolInput(
  input: CreateRoutineInput,
): PersonalRoutineSchedule | string {
  const time = input.time?.trim();
  const needsTime = input.frequency !== "every_n_hours";
  if (needsTime && (time === undefined || !TIME_PATTERN.test(time))) {
    return "Give the time as local 24-hour HH:MM, e.g. 09:00.";
  }
  switch (input.frequency) {
    case "daily":
      return { kind: "daily", time: time! };
    case "weekly":
      if (input.days === undefined || input.days.length === 0) {
        return "Weekly routines need at least one day.";
      }
      return { kind: "weekly", days: input.days.map((day) => WEEKDAY_NUMBER[day]), time: time! };
    case "every_n_hours":
      return input.everyHours === undefined
        ? "every_n_hours routines need everyHours (1 to 168)."
        : { kind: "interval", everyHours: input.everyHours };
    case "once": {
      const date = input.date?.trim();
      return date === undefined || !DATE_PATTERN.test(date)
        ? "One-off routines need a date as YYYY-MM-DD."
        : { kind: "once", at: `${date}T${time!}` };
    }
  }
}

/** "Mon 14 Sept, 09:00 BST" in the routine's own zone. */
export function formatNextRun(instantIso: string | null, timeZone: string): string | null {
  if (instantIso === null) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(Date.parse(instantIso));
}

const make = Effect.gen(function* () {
  const routines = yield* PersonalRoutineService.PersonalRoutineService;
  const memory = yield* PersonalMemoryService.PersonalMemoryService;
  const bots = yield* PersonalBotRepository.PersonalBotRepository;

  const refuse = (reason: string) => new PersonalToolError({ reason });

  // Capability first (granted only to personal-bot threads), then the bot
  // that owns this thread.
  const requireBotThread = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("personal");
    const botId = yield* memory.botForThread(scope.threadId);
    if (Option.isNone(botId)) {
      return yield* refuse("These tools are available only in a personal bot chat.");
    }
    return { scope, botId: botId.value };
  });

  const liveBots = bots.listBots().pipe(Effect.mapError(() => refuse("Could not read the bots.")));

  return PersonalToolkit.of({
    create_routine: (input) =>
      Effect.gen(function* () {
        const { scope, botId } = yield* requireBotThread;
        const schedule = routineScheduleFromToolInput(input);
        if (typeof schedule === "string") return yield* refuse(schedule);
        let targetBotId = botId;
        const wanted = input.botName?.trim().toLowerCase();
        if (wanted !== undefined && wanted.length > 0) {
          const all = yield* liveBots;
          const match = all.find((bot) => bot.name.toLowerCase() === wanted);
          if (match === undefined) {
            return yield* refuse(
              `No bot is named '${input.botName}'. Bots: ${all.map((bot) => bot.name).join(", ")}.`,
            );
          }
          targetBotId = match.botId;
        }
        // Derived from the call itself, so a retried tool call dedupes.
        const routineId = PersonalRoutineId.make(
          `routine-${NodeCrypto.createHash("sha256")
            .update(`${scope.threadId}\n${encodeCreateRoutineInput(input)}`)
            .digest("hex")
            .slice(0, 24)}`,
        );
        const routine = yield* routines
          .create({
            routineId,
            botId: targetBotId,
            title: input.title,
            prompt: input.prompt,
            schedule,
            ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
            missedPolicy: input.missedRuns === "skip" ? "skip" : "coalesce",
          })
          .pipe(Effect.mapError((error) => refuse(error.message)));
        const nextRunUtc =
          routine.nextDueAt === null ? null : DateTime.formatIso(routine.nextDueAt);
        const nextRunLocal = formatNextRun(nextRunUtc, routine.timeZone);
        return {
          routineId: routine.routineId,
          summary: `${routine.title}: ${describePersonalRoutineTrigger(routine)}. Next run: ${nextRunLocal ?? "none"}.`,
          timeZone: routine.timeZone,
          nextRunLocal,
          nextRunUtc,
        };
      }),
    list_routines: () =>
      Effect.gen(function* () {
        yield* requireBotThread;
        const [all, botList] = yield* Effect.all([
          routines.list().pipe(Effect.mapError((error) => refuse(error.message))),
          liveBots,
        ]);
        const names = new Map(botList.map((bot) => [bot.botId, bot.name]));
        return {
          routines: all.routines.map((routine) => ({
            routineId: routine.routineId,
            title: routine.title,
            botName: names.get(routine.botId) ?? "(deleted bot)",
            schedule: describePersonalRoutineTrigger(routine),
            enabled: routine.enabled,
            nextRunLocal: routine.enabled
              ? formatNextRun(
                  routine.nextDueAt === null ? null : DateTime.formatIso(routine.nextDueAt),
                  routine.timeZone,
                )
              : null,
          })),
        };
      }),
    search_memory: (input) =>
      Effect.gen(function* () {
        const { botId } = yield* requireBotThread;
        const entries = yield* memory
          .search({ query: input.query, botId, limit: input.limit ?? 8 })
          .pipe(Effect.mapError((error) => refuse(error.message)));
        return {
          entries: entries.map((entry) => ({
            memoryId: entry.memoryId,
            kind: entry.kind,
            scope: entry.scope,
            content: entry.content,
            updatedAt: DateTime.formatIso(entry.updatedAt),
          })),
        };
      }),
    save_memory: (input) =>
      Effect.gen(function* () {
        const { botId } = yield* requireBotThread;
        if (!EXPLICIT_REMEMBER_REQUEST.test(input.userRequest)) {
          return yield* refuse(
            "Only save memory when the user explicitly asks you to remember something, and pass their words in userRequest.",
          );
        }
        const scope = input.scope ?? "shared";
        const entry = yield* memory
          .save({
            scope,
            scopeId: scope === "bot" ? botId : null,
            kind: input.kind ?? "note",
            content: input.content,
            source: `bot:${botId}`,
          })
          .pipe(Effect.mapError((error) => refuse(error.message)));
        return { memoryId: entry.memoryId, scope: entry.scope, kind: entry.kind };
      }),
  });
});

export const PersonalToolkitHandlersLive = PersonalToolkit.toLayer(make);
