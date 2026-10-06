import * as Effect from "effect/Effect";

import type {
  PersonalBotThreadsBatchResult,
  PersonalBotUpdateThreadsInput,
  ThreadId,
} from "@t3tools/contracts";

import { forEachItem } from "./bulkPersonalItems.ts";
import { deletePersonalChat, type PersonalChatDeleteServices } from "./deletePersonalChat.ts";
import type * as PersonalBotService from "./PersonalBotService.ts";

/** Runs `action` for each chat in turn; see `forEachItem`. */
const forEachChat = Effect.fn("forEachChat")(function* <E, R>(
  threadIds: ReadonlyArray<ThreadId>,
  fallback: string,
  action: (threadId: ThreadId) => Effect.Effect<unknown, E, R>,
) {
  const result = yield* forEachItem(threadIds, fallback, action);
  return {
    done: result.done,
    failed: result.failed.map(({ id, message }) => ({ threadId: id, message })),
  } satisfies PersonalBotThreadsBatchResult;
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

/** Pins, snoozes or marks unread several chats, each through the bot service's `updateThread`. */
export const updatePersonalChats = Effect.fn("updatePersonalChats")(function* (
  bots: PersonalBotService.PersonalBotService["Service"],
  input: PersonalBotUpdateThreadsInput,
) {
  const result = yield* forEachChat(input.threadIds, "Couldn't change this chat.", (threadId) =>
    bots.updateThread({
      threadId,
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.snoozedUntil === undefined ? {} : { snoozedUntil: input.snoozedUntil }),
      ...(input.markUnread === undefined ? {} : { markUnread: input.markUnread }),
    }),
  );
  yield* Effect.logInfo("personal chats update", {
    requested: input.threadIds.length,
    changed: result.done.length,
    failed: result.failed.length,
    ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
    ...(input.snoozedUntil === undefined ? {} : { snoozed: input.snoozedUntil !== null }),
    ...(input.markUnread === undefined ? {} : { markUnread: input.markUnread }),
  });
  return result;
});
