import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  PersonalBotsError,
  PersonalLoginId,
  PersonalLoginsError,
  PersonalMemoryError,
  PersonalMemoryId,
  PersonalRoutineId,
  PersonalRoutinesError,
} from "@t3tools/contracts";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  deletePersonalFiles,
  deletePersonalLogins,
  deletePersonalMemories,
  deletePersonalRoutines,
  setPersonalRoutinesEnabled,
} from "./bulkPersonalItems.ts";
import { PersonalMemoryService, layer as memoryLayer } from "./memory/PersonalMemoryService.ts";
import type * as PersonalBotService from "./PersonalBotService.ts";
import type * as PersonalRoutineService from "./routines/PersonalRoutineService.ts";
import type * as PersonalLoginService from "./secrets/PersonalLoginService.ts";

const MemoryLayer = memoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

describe("deletePersonalFiles", () => {
  it.effect("deletes each file once, in order, and reports the ones refused", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const bots = {
        deleteFile: ({ fileId }: { fileId: string }) =>
          Effect.suspend(() => {
            calls.push(fileId);
            if (fileId === "gone") {
              return Effect.fail(
                new PersonalBotsError({ message: "Personal file 'gone' was not found." }),
              );
            }
            if (fileId === "locked") return Effect.die(new Error("EBUSY: C:\\secret\\path"));
            return Effect.void;
          }),
      } as unknown as PersonalBotService.PersonalBotService["Service"];

      const result = yield* deletePersonalFiles(bots, ["a", "gone", "b", "a", "locked", "c"]);

      assert.deepEqual(calls, ["a", "gone", "b", "locked", "c"]);
      assert.deepEqual(result.done, ["a", "b", "c"]);
      assert.deepEqual(result.failed, [
        { fileId: "gone", message: "Personal file 'gone' was not found." },
        // A defect keeps its internals (here a local path) off the phone.
        { fileId: "locked", message: "Couldn't delete this file." },
      ]);
    }),
  );
});

describe("deletePersonalMemories", () => {
  it.effect("tombstones every picked entry and leaves the rest", () =>
    Effect.gen(function* () {
      const memory = yield* PersonalMemoryService;
      const save = (content: string) =>
        memory.save({ scope: "shared", scopeId: null, kind: "note", content, source: "user" });
      const one = yield* save("The user's cat is called Biscuit.");
      const two = yield* save("The user plays tennis on Saturdays.");
      const three = yield* save("The user prefers tea over coffee.");

      const result = yield* deletePersonalMemories(memory, [
        one.memoryId,
        three.memoryId,
        one.memoryId,
      ]);

      assert.deepEqual(result, { done: [one.memoryId, three.memoryId], failed: [] });
      const left = yield* memory.list({});
      assert.deepEqual(
        left.map((entry) => entry.memoryId),
        [two.memoryId],
      );
      expect(yield* memory.search({ query: "Biscuit cat" })).toEqual([]);
    }).pipe(Effect.provide(MemoryLayer)),
  );

  it.effect("keeps going past a failed entry and uses the service's own message", () =>
    Effect.gen(function* () {
      const bad = PersonalMemoryId.make("memory-bad");
      const good = PersonalMemoryId.make("memory-good");
      const memory = {
        remove: ({ memoryId }: { memoryId: PersonalMemoryId }) =>
          memoryId === bad
            ? Effect.fail(new PersonalMemoryError({ message: "Personal memory delete failed." }))
            : Effect.void,
      } as unknown as PersonalMemoryService["Service"];

      const result = yield* deletePersonalMemories(memory, [bad, good]);

      assert.deepEqual(result, {
        done: [good],
        failed: [{ memoryId: bad, message: "Personal memory delete failed." }],
      });
    }),
  );
});

describe("routine batches", () => {
  const a = PersonalRoutineId.make("routine-a");
  const gone = PersonalRoutineId.make("routine-gone");
  const b = PersonalRoutineId.make("routine-b");
  const makeRoutines = (calls: Array<string>) =>
    ({
      remove: ({ routineId }: { routineId: PersonalRoutineId }) =>
        Effect.suspend(() => {
          calls.push(`remove:${routineId}`);
          return routineId === gone
            ? Effect.fail(new PersonalRoutinesError({ message: "Routine not found." }))
            : Effect.void;
        }),
      pause: ({ routineId }: { routineId: PersonalRoutineId }) =>
        Effect.suspend(() => {
          calls.push(`pause:${routineId}`);
          return routineId === gone
            ? Effect.fail(new PersonalRoutinesError({ message: "Routine not found." }))
            : Effect.succeed({ routineId });
        }),
      resume: ({ routineId }: { routineId: PersonalRoutineId }) =>
        Effect.suspend(() => {
          calls.push(`resume:${routineId}`);
          return routineId === gone
            ? Effect.die(new Error("SQLITE_BUSY"))
            : Effect.succeed({ routineId });
        }),
    }) as unknown as PersonalRoutineService.PersonalRoutineService["Service"];

  it.effect("deletes each routine once through remove and reports refusals", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const result = yield* deletePersonalRoutines(makeRoutines(calls), [a, gone, b, a]);
      assert.deepEqual(calls, ["remove:routine-a", "remove:routine-gone", "remove:routine-b"]);
      assert.deepEqual(result, {
        done: [a, b],
        failed: [{ routineId: gone, message: "Routine not found." }],
      });
    }),
  );

  it.effect("pauses through pause and resumes through resume, hiding defects", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const routines = makeRoutines(calls);
      const paused = yield* setPersonalRoutinesEnabled(routines, [a, gone], false);
      const resumed = yield* setPersonalRoutinesEnabled(routines, [gone, b], true);
      assert.deepEqual(calls, [
        "pause:routine-a",
        "pause:routine-gone",
        "resume:routine-gone",
        "resume:routine-b",
      ]);
      assert.deepEqual(paused, {
        done: [a],
        failed: [{ routineId: gone, message: "Routine not found." }],
      });
      assert.deepEqual(resumed, {
        done: [b],
        failed: [{ routineId: gone, message: "Couldn't resume this routine." }],
      });
    }),
  );
});

describe("deletePersonalLogins", () => {
  it.effect("deletes each login through remove and keeps going past a refusal", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const one = PersonalLoginId.make("login-1");
      const locked = PersonalLoginId.make("login-locked");
      const two = PersonalLoginId.make("login-2");
      const logins = {
        remove: ({ loginId }: { loginId: PersonalLoginId }) =>
          Effect.suspend(() => {
            calls.push(loginId);
            return loginId === locked
              ? Effect.fail(new PersonalLoginsError({ message: "Could not delete the password." }))
              : Effect.void;
          }),
      } as unknown as PersonalLoginService.PersonalLoginService["Service"];

      const result = yield* deletePersonalLogins(logins, [one, locked, two, two]);

      assert.deepEqual(calls, [one, locked, two]);
      assert.deepEqual(result, {
        done: [one, two],
        failed: [{ loginId: locked, message: "Could not delete the password." }],
      });
    }),
  );
});
