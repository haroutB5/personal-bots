import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PersonalBotsError, PersonalMemoryError, PersonalMemoryId } from "@t3tools/contracts";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { deletePersonalFiles, deletePersonalMemories } from "./bulkPersonalItems.ts";
import { PersonalMemoryService, layer as memoryLayer } from "./memory/PersonalMemoryService.ts";
import type * as PersonalBotService from "./PersonalBotService.ts";

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
