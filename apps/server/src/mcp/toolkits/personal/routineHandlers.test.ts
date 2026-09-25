import {
  EnvironmentId,
  PersonalBotId,
  PersonalRoutineId,
  PersonalRoutinesError,
  ProviderInstanceId,
  ThreadId,
  type PersonalBot,
  type PersonalRoutine,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import { PersonalBotRepository } from "../../../personal/PersonalBotRepository.ts";
import { PersonalBrowser } from "../../../personal/browser/PersonalBrowser.ts";
import { PersonalMemoryService } from "../../../personal/memory/PersonalMemoryService.ts";
import { PersonalRoutineService } from "../../../personal/routines/PersonalRoutineService.ts";
import { PersonalSessionAccess } from "../../../personal/secrets/PersonalSessionAccess.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { PersonalToolkitHandlersLive } from "./handlers.ts";
import { PersonalToolkit } from "./tools.ts";

const encodeResult = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const epoch = DateTime.makeUnsafe("2026-09-23T00:00:00.000Z");
const nextDue = DateTime.makeUnsafe("2026-09-24T06:00:00.000Z");

const bot = (botId: string, name: string): PersonalBot => ({
  botId: PersonalBotId.make(botId),
  name,
  title: "",
  description: "",
  instructions: "",
  avatarShape: "blob",
  avatarColor: "#1A73E8",
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  enabled: true,
  sortOrder: 0,
  createdAt: epoch,
  updatedAt: epoch,
});
const BOTS = [bot("scheduler", "Scheduler"), bot("sync", "Sync reports")];

const routine = (
  fields: Omit<Partial<PersonalRoutine>, "routineId"> & { readonly routineId: string },
): PersonalRoutine => ({
  botId: PersonalBotId.make("scheduler"),
  title: "Morning briefing",
  prompt: "Brief me.",
  trigger: "schedule",
  schedule: { kind: "daily", time: "07:00" },
  eventLabel: null,
  hookToken: null,
  lastFiredAt: null,
  timeZone: "Europe/London",
  enabled: true,
  missedPolicy: "coalesce",
  nextDueAt: nextDue,
  lastOccurrenceLocal: null,
  createdAt: epoch,
  updatedAt: epoch,
  ...fields,
  routineId: PersonalRoutineId.make(fields.routineId),
});

/** An in-memory routine service with the real service's observable rules. */
function fakeRoutines(initial: ReadonlyArray<PersonalRoutine>) {
  const store = new Map<string, PersonalRoutine>(initial.map((entry) => [entry.routineId, entry]));
  const missing = (routineId: string) =>
    new PersonalRoutinesError({ message: `Routine '${routineId}' was not found.` });
  const read = (routineId: string): Effect.Effect<PersonalRoutine, PersonalRoutinesError> => {
    const found = store.get(routineId);
    return found === undefined ? Effect.fail(missing(routineId)) : Effect.succeed(found);
  };
  const write = (next: PersonalRoutine) => {
    store.set(next.routineId, next);
    return next;
  };
  return {
    store,
    layer: Layer.mock(PersonalRoutineService)({
      list: () => Effect.succeed({ routines: [...store.values()], occurrences: [] }),
      create: (input) =>
        Effect.sync(() =>
          write(
            routine({
              routineId: input.routineId,
              botId: input.botId,
              title: input.title,
              prompt: input.prompt,
              threadId: input.threadId ?? null,
              newChatEachRun: input.newChatEachRun === true,
            }),
          ),
        ),
      get: ({ routineId }) => read(routineId),
      update: (input) =>
        read(input.routineId).pipe(
          Effect.map((current) =>
            write({
              ...current,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
              ...(input.botId === undefined ? {} : { botId: input.botId }),
              ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
              ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
              ...(input.newChatEachRun === undefined
                ? {}
                : { newChatEachRun: input.newChatEachRun }),
            }),
          ),
        ),
      pause: ({ routineId }) =>
        read(routineId).pipe(Effect.map((current) => write({ ...current, enabled: false }))),
      resume: ({ routineId }) =>
        read(routineId).pipe(Effect.map((current) => write({ ...current, enabled: true }))),
      remove: ({ routineId }) => Effect.sync(() => void store.delete(routineId)),
    }),
  };
}

function call(
  routines: ReturnType<typeof fakeRoutines>,
  tool:
    | "create_routine"
    | "update_routine"
    | "set_routine_enabled"
    | "delete_routine"
    | "list_routines",
  params: Record<string, unknown>,
) {
  const layer = PersonalToolkitHandlersLive.pipe(
    Layer.provide(Layer.mock(PersonalBrowser)({ sensitiveExposure: () => Effect.succeed([]) })),
    Layer.provide(Layer.mock(PersonalBotRepository)({ listBots: () => Effect.succeed(BOTS) })),
    Layer.provide(routines.layer),
    Layer.provide(
      Layer.mock(PersonalMemoryService)({
        botForThread: () => Effect.succeed(Option.some(PersonalBotId.make("scheduler"))),
      }),
    ),
    Layer.provide(Layer.mock(PersonalSessionAccess)({})),
  );
  return Effect.gen(function* () {
    const toolkit = yield* PersonalToolkit;
    const result = yield* toolkit
      // The params are each tool's own input; the union of names needs a widening cast.
      .handle(tool as "update_routine", params as never)
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.catch((error) => Effect.succeed(String(error))),
      );
    return encodeResult(result);
  }).pipe(
    Effect.provide(layer),
    Effect.provideService(McpInvocationContext, {
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      providerSessionId: "session",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      capabilities: new Set(["personal" as const]),
      issuedAt: 1,
    }),
  );
}

describe("routine management tools", () => {
  it.effect("update_routine changes the prompt, schedule and bot, leaving the rest", () =>
    Effect.gen(function* () {
      const routines = fakeRoutines([routine({ routineId: "r1" })]);
      yield* call(routines, "update_routine", {
        routineId: "r1",
        prompt: "Brief me on markets.",
        frequency: "weekly",
        days: ["monday"],
        time: "08:30",
        botName: "sync reports",
      });
      const updated = routines.store.get("r1");
      expect(updated?.prompt).toBe("Brief me on markets.");
      expect(updated?.schedule).toEqual({ kind: "weekly", days: [1], time: "08:30" });
      expect(updated?.botId).toBe("sync");
      expect(updated?.title).toBe("Morning briefing");
    }),
  );

  it.effect("update_routine refuses a schedule for a routine a webhook starts", () =>
    Effect.gen(function* () {
      const routines = fakeRoutines([
        routine({
          routineId: "hook",
          trigger: "event",
          schedule: null,
          eventLabel: "Upstream sync",
          nextDueAt: null,
        }),
      ]);
      const result = yield* call(routines, "update_routine", {
        routineId: "hook",
        frequency: "daily",
        time: "09:00",
      });
      expect(result).toContain("no schedule to change");
      expect(routines.store.get("hook")?.schedule).toBeNull();
    }),
  );

  it.effect("update_routine and set_routine_enabled pause and resume", () =>
    Effect.gen(function* () {
      const routines = fakeRoutines([routine({ routineId: "r1" })]);
      const paused = yield* call(routines, "set_routine_enabled", {
        routineId: "r1",
        enabled: false,
      });
      expect(routines.store.get("r1")?.enabled).toBe(false);
      expect(paused).toContain("Paused");
      yield* call(routines, "update_routine", { routineId: "r1", enabled: true });
      expect(routines.store.get("r1")?.enabled).toBe(true);
    }),
  );

  it.effect("delete_routine removes only the routine its id and title both name", () =>
    Effect.gen(function* () {
      const routines = fakeRoutines([
        routine({ routineId: "r1" }),
        routine({ routineId: "r2", title: "Upstream probe" }),
      ]);
      const mismatch = yield* call(routines, "delete_routine", {
        routineId: "r1",
        title: "Upstream probe",
      });
      expect(mismatch).toContain("Nothing was deleted");
      expect([...routines.store.keys()]).toEqual(["r1", "r2"]);

      const unknown = yield* call(routines, "delete_routine", {
        routineId: "r9",
        title: "Morning briefing",
      });
      expect(unknown).toContain("list_routines");
      expect([...routines.store.keys()]).toEqual(["r1", "r2"]);

      const deleted = yield* call(routines, "delete_routine", {
        routineId: "r2",
        title: "Upstream probe",
      });
      expect(deleted).toContain("Deleted the routine 'Upstream probe'");
      expect([...routines.store.keys()]).toEqual(["r1"]);
    }),
  );

  it.effect("list_routines hands back the id and prompt the other tools need", () =>
    Effect.gen(function* () {
      const routines = fakeRoutines([routine({ routineId: "r1" })]);
      const listed = yield* call(routines, "list_routines", {});
      expect(listed).toContain('"routineId":"r1"');
      expect(listed).toContain('"prompt":"Brief me."');
    }),
  );
});

describe("routines run in the chat they were created from", () => {
  it.effect("create_routine records the calling chat unless newChatEachRun is set", () =>
    Effect.gen(function* () {
      const routines = fakeRoutines([]);
      const inChat = yield* call(routines, "create_routine", {
        title: "Confirm release",
        prompt: "Check it.",
        frequency: "once",
        date: "2026-09-25",
        time: "16:20",
      });
      const optedOut = yield* call(routines, "create_routine", {
        title: "Nightly",
        prompt: "Report.",
        frequency: "daily",
        time: "04:00",
        newChatEachRun: true,
      });
      const [first, second] = [...routines.store.values()];
      expect([first?.threadId, first?.newChatEachRun]).toEqual(["thread", false]);
      expect([second?.threadId, second?.newChatEachRun]).toEqual(["thread", true]);
      expect(inChat).toContain("Each run is posted in this chat.");
      expect(optedOut).toContain("Each run opens a new chat.");
    }),
  );

  it.effect("list_routines says where each routine's runs go", () =>
    Effect.gen(function* () {
      const routines = fakeRoutines([
        routine({ routineId: "here", threadId: ThreadId.make("thread") }),
        routine({ routineId: "elsewhere", threadId: ThreadId.make("other-chat") }),
        routine({
          routineId: "opted-out",
          threadId: ThreadId.make("thread"),
          newChatEachRun: true,
        }),
        routine({ routineId: "screen" }),
      ]);
      // The encoded tool result, fields in schema order.
      const rows = yield* call(routines, "list_routines", {});
      for (const [routineId, newChat, here] of [
        ["here", false, true],
        ["elsewhere", false, false],
        ["opted-out", true, false],
        ["screen", true, false],
      ] as const) {
        const pattern = new RegExp(
          `"routineId":"${routineId}"[^}]*"newChatEachRun":${newChat},"runsInThisChat":${here}`,
        );
        expect(rows).toMatch(pattern);
      }
    }),
  );

  it.effect("update_routine flips newChatEachRun, and refuses a chat for a screen-made one", () =>
    Effect.gen(function* () {
      const routines = fakeRoutines([
        routine({ routineId: "r1", threadId: ThreadId.make("thread") }),
        routine({ routineId: "screen" }),
      ]);
      const out = yield* call(routines, "update_routine", {
        routineId: "r1",
        newChatEachRun: true,
      });
      expect(routines.store.get("r1")?.newChatEachRun).toBe(true);
      expect(out).toContain("Each run opens a new chat.");
      const back = yield* call(routines, "update_routine", {
        routineId: "r1",
        newChatEachRun: false,
      });
      expect(routines.store.get("r1")?.newChatEachRun).toBe(false);
      expect(back).toContain("Each run is posted in this chat.");
      const refused = yield* call(routines, "update_routine", {
        routineId: "screen",
        newChatEachRun: false,
      });
      expect(refused).toContain("was not created from a chat");
    }),
  );
});
