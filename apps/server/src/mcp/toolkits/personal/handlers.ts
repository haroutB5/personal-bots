import * as NodeCrypto from "node:crypto";

import {
  describePersonalRoutineTrigger,
  PersonalRoutineId,
  type PersonalRoutine,
  type PersonalRoutineSchedule,
  savesMemoryWithoutAsking,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as PersonalBotRepository from "../../../personal/PersonalBotRepository.ts";
import { PersonalBrowser } from "../../../personal/browser/PersonalBrowser.ts";
import { PersonalSessionAccess } from "../../../personal/secrets/PersonalSessionAccess.ts";
import { createResearchClient } from "../../../personal/research/researchClient.ts";
import * as PersonalMemoryService from "../../../personal/memory/PersonalMemoryService.ts";
import * as PersonalRoutineService from "../../../personal/routines/PersonalRoutineService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  CreateRoutineInput,
  PersonalToolError,
  PersonalToolkit,
  type RoutineScheduleToolFields,
  type UpdateRoutineInput,
} from "./tools.ts";

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

/** save_memory runs on an explicit ask from the user, or with the bot's standing permission. */
export const EXPLICIT_REMEMBER_REQUEST =
  /\b(remember|memori[sz]e|don'?t forget|do not forget|keep in mind|save (this|that|it)|note (this|that|it) down|for future reference)\b/i;

/**
 * Why save_memory must not write, or null when it may. An explicit ask always
 * may. Otherwise only a bot the owner gave standing permission (memoryAutoSave)
 * may, and never in a chat that has had a user-marked sensitive site open: the
 * permission covers what the user tells the bot, not what the bot read on
 * their bank, and bot memory reaches every later chat where the egress guard
 * would see a clean thread.
 */
export function saveMemoryRefusal(input: {
  readonly userRequest: string;
  readonly autoSave: boolean;
  readonly sensitiveOrigins: ReadonlyArray<string>;
}): string | null {
  if (EXPLICIT_REMEMBER_REQUEST.test(input.userRequest)) return null;
  if (!input.autoSave) {
    return "Only save memory when the user explicitly asks you to remember something, and pass their words in userRequest.";
  }
  if (input.sensitiveOrigins.length > 0) {
    return `Not saved: this chat has had ${input.sensitiveOrigins.join(", ")} open, a site the user marked sensitive, so saving without being asked is closed for the rest of it. Tell the user what you would have saved and ask them to say "remember" if they want it kept.`;
  }
  return null;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Maps the tool's natural fields onto a routine schedule, or explains what is missing. */
export function routineScheduleFromToolInput(
  input: RoutineScheduleToolFields,
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

/** Whether a routine's runs open a new chat rather than going into its source chat. */
export const opensNewChat = (routine: PersonalRoutine) =>
  (routine.threadId ?? null) === null || routine.newChatEachRun === true;

/** Where the runs go, as a sentence for the confirmation. */
export const routineRunsIn = (routine: PersonalRoutine, callerThreadId: string) =>
  opensNewChat(routine)
    ? "Each run opens a new chat."
    : routine.threadId === callerThreadId
      ? "Each run is posted in this chat."
      : "Each run is posted in the chat it was created in.";

/** The confirmation update_routine and set_routine_enabled hand back. */
export function routineChangeResult(routine: PersonalRoutine, callerThreadId?: string) {
  const nextRunUtc =
    routine.enabled && routine.nextDueAt !== null ? DateTime.formatIso(routine.nextDueAt) : null;
  const nextRunLocal = formatNextRun(nextRunUtc, routine.timeZone);
  const state = routine.enabled ? `Next run: ${nextRunLocal ?? "none"}` : "Paused";
  return {
    routineId: routine.routineId,
    summary: `${routine.title}: ${describePersonalRoutineTrigger(routine)}. ${state}.${
      callerThreadId === undefined ? "" : ` ${routineRunsIn(routine, callerThreadId)}`
    }`,
    enabled: routine.enabled,
    timeZone: routine.timeZone,
    nextRunLocal,
    nextRunUtc,
  };
}

/** Whether update_routine was handed any of the schedule fields. */
const touchesSchedule = (input: UpdateRoutineInput) =>
  input.frequency !== undefined ||
  input.time !== undefined ||
  input.days !== undefined ||
  input.everyHours !== undefined ||
  input.date !== undefined;

const make = Effect.gen(function* () {
  const routines = yield* PersonalRoutineService.PersonalRoutineService;
  const memory = yield* PersonalMemoryService.PersonalMemoryService;
  const bots = yield* PersonalBotRepository.PersonalBotRepository;
  const sessions = yield* PersonalSessionAccess;
  const browser = yield* PersonalBrowser;
  const research = createResearchClient();

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

  /**
   * The live bot a routine tool names, matched case-insensitively on the
   * whole name; undefined when no name was given. Any live bot may run a
   * routine, as in the app's own routine editor: routines are not team-scoped.
   */
  const botByName = Effect.fn("personal.routineBotByName")(function* (name: string | undefined) {
    const wanted = name?.trim().toLowerCase();
    if (wanted === undefined || wanted.length === 0) return undefined;
    const all = yield* liveBots;
    const match = all.find((bot) => bot.name.toLowerCase() === wanted);
    if (match === undefined) {
      return yield* refuse(
        `No bot is named '${name}'. Bots: ${all.map((bot) => bot.name).join(", ")}.`,
      );
    }
    return match.botId;
  });

  const routineError = (error: { readonly message: string }) => refuse(error.message);

  /** Reads a routine by the id the model gave, with a refusal that says what to do next. */
  const requireRoutine = (routineId: string) =>
    routines
      .get({ routineId: PersonalRoutineId.make(routineId) })
      .pipe(
        Effect.mapError(() =>
          refuse(
            `No routine has the id '${routineId}'. Call list_routines and use a routineId exactly as it returns it.`,
          ),
        ),
      );

  /** Pauses or resumes, leaving a routine already in that state untouched. */
  const setEnabled = (routine: PersonalRoutine, enabled: boolean) =>
    routine.enabled === enabled
      ? Effect.succeed(routine)
      : (enabled
          ? routines.resume({ routineId: routine.routineId })
          : routines.pause({ routineId: routine.routineId })
        ).pipe(
          Effect.mapError((error) =>
            enabled && routine.schedule?.kind === "once"
              ? refuse(
                  `'${routine.title}' was a one-off whose time has passed, so it could not be resumed and has been removed. Create a new routine for a new time.`,
                )
              : routineError(error),
          ),
        );

  /**
   * The sensitive-site egress guard, for the one channel it cannot see.
   *
   * The browser rail pauses an action that could carry what a bot read on a
   * user-marked sensitive site to another origin, and lets the user approve
   * that one destination. These tools are outside the browser and the shape
   * does not transfer: their destination is always the search provider, so an
   * approval would be a standing permit to send anything this thread read on
   * the bank to Tavily, bought with a question about a browser the user has
   * nothing to look at in. So this end refuses outright, for as long as the
   * thread's exposure set is non-empty, and offers no approval to grant.
   *
   * The check is on thread state, never on the arguments, so rewording the
   * query, splitting it up or renaming the tool changes nothing. The refusal
   * names the origin the bot itself opened and never any page content.
   */
  const refuseWhileCarryingSensitiveData = Effect.fn("personal.researchEgressGuard")(function* (
    threadId: ThreadId,
  ) {
    const carrying = yield* browser.sensitiveExposure(threadId);
    if (carrying.length === 0) return;
    return yield* refuse(
      `Blocked: this chat has had ${carrying.join(", ")} open, a site the user marked sensitive, so the research tools are closed for the rest of it. They send text to an outside search provider and there is no approval that reopens them; retrying with different words will not work. Say in one sentence what you wanted to look up and ask the user to search it, or open a public page in the browser yourself.`,
    );
  });

  const researchAccess = Effect.fn("personal.researchAccess")(function* (name: string) {
    const { scope, botId } = yield* requireBotThread;
    yield* refuseWhileCarryingSensitiveData(scope.threadId);
    const grant = yield* sessions.forThread(scope.threadId);
    const key = grant.environment[`PB_SECRET_${name}`];
    if (!key)
      return yield* refuse(
        `Save ${name} using request_secret to enable this tool. Use native web search or the browser meanwhile. Do not ask for keys in chat.`,
      );
    return { key, scope: botId };
  });

  return PersonalToolkit.of({
    search_web: (input) =>
      Effect.gen(function* () {
        const access = yield* researchAccess("TAVILY_API_KEY");
        const results = yield* Effect.tryPromise({
          // The signal is the fiber's: interrupting the turn aborts the fetches
          // and hands their concurrency slots straight back.
          try: (signal) =>
            research.search(
              access.scope,
              access.key,
              input.queries,
              {
                country: input.country,
                timeRange: input.timeRange,
                domains: input.domains,
              },
              signal,
            ),
          catch: () => refuse("Web search failed."),
        });
        return { results };
      }),
    read_pages: (input) =>
      Effect.gen(function* () {
        const access = yield* researchAccess("TAVILY_API_KEY");
        const results = yield* Effect.tryPromise({
          try: (signal) => research.read(access.scope, access.key, input.urls, signal),
          catch: () => refuse("Page reading failed."),
        });
        return { results };
      }),
    search_google: (input) =>
      Effect.gen(function* () {
        const access = yield* researchAccess("SERPAPI_API_KEY");
        return yield* Effect.tryPromise({
          try: (signal) =>
            research.google(
              access.scope,
              access.key,
              input.query,
              { country: input.country, timeRange: input.timeRange, num: input.num },
              signal,
            ),
          catch: () => refuse("Google search failed."),
        });
      }),
    search_products: (input) =>
      Effect.gen(function* () {
        const access = yield* researchAccess("SERPAPI_API_KEY");
        return yield* Effect.tryPromise({
          try: (signal) =>
            research.products(access.scope, access.key, input.query, input.country, signal),
          catch: () => refuse("Product search failed."),
        });
      }),
    create_routine: (input) =>
      Effect.gen(function* () {
        const { scope, botId } = yield* requireBotThread;
        const schedule = routineScheduleFromToolInput(input);
        if (typeof schedule === "string") return yield* refuse(schedule);
        const targetBotId = (yield* botByName(input.botName)) ?? botId;
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
            // The chat that asked for it: each run comes back here unless opted out.
            threadId: scope.threadId,
            newChatEachRun: input.newChatEachRun === true,
          })
          .pipe(Effect.mapError((error) => refuse(error.message)));
        const nextRunUtc =
          routine.nextDueAt === null ? null : DateTime.formatIso(routine.nextDueAt);
        const nextRunLocal = formatNextRun(nextRunUtc, routine.timeZone);
        return {
          routineId: routine.routineId,
          summary: `${routine.title}: ${describePersonalRoutineTrigger(routine)}. Next run: ${nextRunLocal ?? "none"}. ${routineRunsIn(routine, scope.threadId)}`,
          timeZone: routine.timeZone,
          nextRunLocal,
          nextRunUtc,
        };
      }),
    list_routines: () =>
      Effect.gen(function* () {
        const { scope } = yield* requireBotThread;
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
            newChatEachRun: opensNewChat(routine),
            runsInThisChat: !opensNewChat(routine) && routine.threadId === scope.threadId,
            prompt: routine.prompt,
            nextRunLocal: routine.enabled
              ? formatNextRun(
                  routine.nextDueAt === null ? null : DateTime.formatIso(routine.nextDueAt),
                  routine.timeZone,
                )
              : null,
          })),
        };
      }),
    update_routine: (input) =>
      Effect.gen(function* () {
        const { scope } = yield* requireBotThread;
        const current = yield* requireRoutine(input.routineId);
        let schedule: PersonalRoutineSchedule | undefined;
        if (touchesSchedule(input)) {
          if (current.schedule === null) {
            return yield* refuse(
              `'${current.title}' runs when its webhook event '${current.eventLabel ?? "event"}' fires, so it has no schedule to change.`,
            );
          }
          if (input.frequency === undefined) {
            return yield* refuse(
              "Give the whole new schedule: frequency, plus the time, days, everyHours or date it needs.",
            );
          }
          const mapped = routineScheduleFromToolInput({ ...input, frequency: input.frequency });
          if (typeof mapped === "string") return yield* refuse(mapped);
          schedule = mapped;
        }
        const botId = yield* botByName(input.botName);
        const timeZone = input.timeZone?.trim();
        const edits = {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
          ...(schedule === undefined ? {} : { schedule }),
          ...(timeZone === undefined || timeZone.length === 0 ? {} : { timeZone }),
          ...(input.missedRuns === undefined
            ? {}
            : {
                missedPolicy:
                  input.missedRuns === "skip" ? ("skip" as const) : ("coalesce" as const),
              }),
          ...(botId === undefined ? {} : { botId }),
          ...(input.newChatEachRun === undefined ? {} : { newChatEachRun: input.newChatEachRun }),
        };
        if (input.newChatEachRun === false && (current.threadId ?? null) === null) {
          return yield* refuse(
            `'${current.title}' was not created from a chat, so each run always opens a new chat.`,
          );
        }
        if (Object.keys(edits).length === 0 && input.enabled === undefined) {
          return yield* refuse("Nothing to change: pass at least one field to update.");
        }
        let routine = current;
        if (Object.keys(edits).length > 0) {
          routine = yield* routines
            .update({ routineId: current.routineId, ...edits })
            .pipe(Effect.mapError(routineError));
        }
        if (input.enabled !== undefined) {
          routine = yield* setEnabled(routine, input.enabled);
        }
        return routineChangeResult(
          routine,
          input.newChatEachRun === undefined ? undefined : scope.threadId,
        );
      }),
    set_routine_enabled: (input) =>
      Effect.gen(function* () {
        yield* requireBotThread;
        const current = yield* requireRoutine(input.routineId);
        return routineChangeResult(yield* setEnabled(current, input.enabled));
      }),
    delete_routine: (input) =>
      Effect.gen(function* () {
        yield* requireBotThread;
        const current = yield* requireRoutine(input.routineId);
        // The title is the model restating which routine it means: an id
        // copied from the wrong row, or a stale one, deletes nothing.
        if (current.title.trim() !== input.title.trim()) {
          return yield* refuse(
            `Nothing was deleted: routine '${current.routineId}' is titled '${current.title}', not '${input.title}'. Call list_routines and check which routine the user means.`,
          );
        }
        yield* routines
          .remove({ routineId: current.routineId })
          .pipe(Effect.mapError(routineError));
        return {
          routineId: current.routineId,
          summary: `Deleted the routine '${current.title}' (${describePersonalRoutineTrigger(current)}).`,
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
        const { scope: invocation, botId } = yield* requireBotThread;
        // The bot row and the thread's taint are read only when the words
        // alone do not already carry the user's ask.
        const explicit = EXPLICIT_REMEMBER_REQUEST.test(input.userRequest);
        const autoSave = explicit
          ? false
          : yield* bots.getBotById({ botId }).pipe(
              Effect.map((bot) => Option.isSome(bot) && savesMemoryWithoutAsking(bot.value)),
              Effect.mapError(() => refuse("Could not read the bot.")),
            );
        const sensitiveOrigins =
          explicit || !autoSave ? [] : yield* browser.sensitiveExposure(invocation.threadId);
        const refusal = saveMemoryRefusal({
          userRequest: input.userRequest,
          autoSave,
          sensitiveOrigins,
        });
        if (refusal !== null) return yield* refuse(refusal);
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
