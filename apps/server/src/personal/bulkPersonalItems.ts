import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type {
  PersonalFilesBatchResult,
  PersonalMemoryBatchResult,
  PersonalMemoryId,
} from "@t3tools/contracts";

import type * as PersonalMemoryService from "./memory/PersonalMemoryService.ts";
import type * as PersonalBotService from "./PersonalBotService.ts";

/** Errors whose own message is written for the owner and is safe to show on the phone. */
const OWNER_FACING_ERRORS = new Set(["PersonalBotsError", "PersonalMemoryError"]);

/**
 * The reason a single action would have shown: a personal error's own
 * message (a chat already gone, a file not found), else the generic line.
 * Defects never leak their internals to the phone.
 */
function failureMessage(cause: Cause.Cause<unknown>, fallback: string): string {
  const error = Cause.squash(cause);
  if (
    typeof error === "object" &&
    error !== null &&
    OWNER_FACING_ERRORS.has(String((error as { _tag?: unknown })._tag)) &&
    typeof (error as { message?: unknown }).message === "string" &&
    (error as { message: string }).message !== ""
  ) {
    return (error as { message: string }).message;
  }
  return fallback;
}

/**
 * Runs `action` for each id in turn (never in parallel: the order the user
 * picked is the order the log shows, and a chat delete dispatches through the
 * one orchestration engine). Duplicates run once. One item failing does not
 * stop the rest; an interrupt does.
 */
export const forEachItem = Effect.fn("forEachItem")(function* <Id, E, R>(
  ids: ReadonlyArray<Id>,
  fallback: string,
  action: (id: Id) => Effect.Effect<unknown, E, R>,
) {
  const done: Array<Id> = [];
  const failed: Array<{ readonly id: Id; readonly message: string }> = [];
  for (const id of new Set(ids)) {
    const exit = yield* Effect.exit(action(id));
    if (Exit.isSuccess(exit)) {
      done.push(id);
      continue;
    }
    if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
    failed.push({ id, message: failureMessage(exit.cause, fallback) });
  }
  return { done, failed };
});

/**
 * Deletes several Files-tab attachments, each through the bot service's
 * `deleteFile`: the same ownership check (only attachments of a live bot's
 * chat) and the same idempotent removal as deleting them one by one.
 */
export const deletePersonalFiles = Effect.fn("deletePersonalFiles")(function* (
  bots: PersonalBotService.PersonalBotService["Service"],
  fileIds: ReadonlyArray<string>,
) {
  const result = yield* forEachItem(fileIds, "Couldn't delete this file.", (fileId) =>
    bots.deleteFile({ fileId }),
  );
  yield* Effect.logInfo("personal files bulk delete", {
    requested: fileIds.length,
    deleted: result.done.length,
    failed: result.failed.length,
  });
  return {
    done: result.done,
    failed: result.failed.map(({ id, message }) => ({ fileId: id, message })),
  } satisfies PersonalFilesBatchResult;
});

/** Deletes several memory entries, each through the memory service's `remove` (a tombstone). */
export const deletePersonalMemories = Effect.fn("deletePersonalMemories")(function* (
  memory: PersonalMemoryService.PersonalMemoryService["Service"],
  memoryIds: ReadonlyArray<PersonalMemoryId>,
) {
  const result = yield* forEachItem(memoryIds, "Couldn't delete this memory.", (memoryId) =>
    memory.remove({ memoryId }),
  );
  yield* Effect.logInfo("personal memory bulk delete", {
    requested: memoryIds.length,
    deleted: result.done.length,
    failed: result.failed.length,
  });
  return {
    done: result.done,
    failed: result.failed.map(({ id, message }) => ({ memoryId: id, message })),
  } satisfies PersonalMemoryBatchResult;
});
