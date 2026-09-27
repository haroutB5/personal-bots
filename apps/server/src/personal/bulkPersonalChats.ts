import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type { PersonalBotThreadsBatchResult, ThreadId } from "@t3tools/contracts";

import { deletePersonalChat, type PersonalChatDeleteServices } from "./deletePersonalChat.ts";
import type * as PersonalBotService from "./PersonalBotService.ts";

/**
 * The reason a single action would have shown: a `PersonalBotsError`'s own
 * message (a group member's chat, a chat already gone), else the generic line.
 * Defects never leak their internals to the phone.
 */
function failureMessage(cause: Cause.Cause<unknown>, fallback: string): string {
  const error = Cause.squash(cause);
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { _tag?: unknown })._tag === "PersonalBotsError" &&
    typeof (error as { message?: unknown }).message === "string" &&
    (error as { message: string }).message !== ""
  ) {
    return (error as { message: string }).message;
  }
  return fallback;
}

/**
 * Runs `action` for each chat in turn (never in parallel: every delete
 * dispatches through the one orchestration engine, and the order the user
 * picked is the order the log shows). One chat failing does not stop the
 * rest; an interrupt does.
 */
const forEachChat = Effect.fn("forEachChat")(function* <E, R>(
  threadIds: ReadonlyArray<ThreadId>,
  fallback: string,
  action: (threadId: ThreadId) => Effect.Effect<unknown, E, R>,
) {
  const done: Array<ThreadId> = [];
  const failed: Array<{ threadId: ThreadId; message: string }> = [];
  for (const threadId of new Set(threadIds)) {
    const exit = yield* Effect.exit(action(threadId));
    if (Exit.isSuccess(exit)) {
      done.push(threadId);
      continue;
    }
    if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
    failed.push({ threadId, message: failureMessage(exit.cause, fallback) });
  }
  return { done, failed } satisfies PersonalBotThreadsBatchResult;
});

/**
 * Deletes several chats, each through `deletePersonalChat`: the same refusal
 * for a group member's thread, the same task cancels, the same thread and
 * link removal as deleting them one by one. The client refreshes its list
 * once, after the whole batch, instead of once per chat.
 */
export const deletePersonalChats = Effect.fn("deletePersonalChats")(function* (
  services: PersonalChatDeleteServices,
  threadIds: ReadonlyArray<ThreadId>,
) {
  const result = yield* forEachChat(threadIds, "Couldn't delete this chat.", (threadId) =>
    deletePersonalChat(services, threadId),
  );
  yield* Effect.logInfo("personal chats bulk delete", {
    requested: threadIds.length,
    deleted: result.done.length,
    failed: result.failed.length,
  });
  return result;
});

/** Archives or unarchives several chats, each through the bot service's `archiveThread`. */
export const archivePersonalChats = Effect.fn("archivePersonalChats")(function* (
  bots: PersonalBotService.PersonalBotService["Service"],
  threadIds: ReadonlyArray<ThreadId>,
  archived: boolean,
) {
  const result = yield* forEachChat(
    threadIds,
    archived ? "Couldn't archive this chat." : "Couldn't unarchive this chat.",
    (threadId) => bots.archiveThread({ threadId, archived }),
  );
  yield* Effect.logInfo("personal chats bulk archive", {
    archived,
    requested: threadIds.length,
    changed: result.done.length,
    failed: result.failed.length,
  });
  return result;
});
