import type {
  EnvironmentId,
  PersonalBotThreadsBatchResult,
  PersonalBotUpdateThreadsInput,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";

import { dropChatFromSnapshot } from "./chatsSnapshot";
import {
  bulkDeleteConfirmLabel,
  bulkDeleteConfirmMessage,
  bulkResultNotice,
  isChatStateAction,
  type BulkChatAction,
  type ChatStateAction,
} from "./chatSelection";
import { commandFailureMessage } from "./commandFeedback";
import { clearChatSeen } from "./unreadChats";
import {
  personalBotArchiveThreads,
  personalBotDeleteThreads,
  personalBotUpdateThreads,
} from "./usePersonalBots";

/** What a state action needs besides the chats: when a snooze ends. */
export interface BulkChatOptions {
  readonly snoozeUntilMs?: number | undefined;
}

function stateInput(
  action: ChatStateAction,
  threadIds: ReadonlyArray<ThreadId>,
  options: BulkChatOptions | undefined,
): PersonalBotUpdateThreadsInput {
  switch (action) {
    case "pin":
      return { threadIds, pinned: true };
    case "unpin":
      return { threadIds, pinned: false };
    case "snooze":
      return { threadIds, snoozedUntil: DateTime.makeUnsafe(options?.snoozeUntilMs ?? Date.now()) };
    case "wake":
      return { threadIds, snoozedUntil: null };
    case "markUnread":
      return { threadIds, markUnread: true };
  }
}

export type BulkChatOutcome =
  | { readonly status: "cancelled" }
  | {
      readonly status: "settled";
      readonly notice: string;
      /** Chats the server refused or could not reach; they stay selected. */
      readonly failedIds: ReadonlyArray<string>;
      readonly anyFailed: boolean;
    };

/**
 * Archive, unarchive, delete, pin, unpin, snooze, wake or mark unread a selection in one request. The server runs
 * each chat through the same path as a single archive or delete, so the
 * database ends up exactly as it would after one action per chat; the list
 * refreshes once, when the whole batch is done. Delete asks once, with the
 * count. A request that fails outright leaves every chat selected.
 */
export function useBulkChatActions(
  environmentId: EnvironmentId | null,
): (
  action: BulkChatAction,
  threadIds: ReadonlyArray<string>,
  workingCount: number,
  options?: BulkChatOptions,
) => Promise<BulkChatOutcome> {
  const archiveThreads = useAtomCommand(personalBotArchiveThreads, { reportFailure: false });
  const deleteThreads = useAtomCommand(personalBotDeleteThreads, { reportFailure: false });
  const updateThreads = useAtomCommand(personalBotUpdateThreads, { reportFailure: false });
  return async (action, threadIds, workingCount, options) => {
    if (threadIds.length === 0) return { status: "cancelled" };
    if (environmentId === null) {
      return {
        status: "settled",
        notice: "Not connected to your computer.",
        failedIds: threadIds,
        anyFailed: true,
      };
    }
    if (action === "delete") {
      const message = bulkDeleteConfirmMessage(threadIds.length, workingCount);
      const confirmed =
        (await requestConfirmDialog(message, {
          variant: "destructive",
          confirmLabel: bulkDeleteConfirmLabel(threadIds.length),
        })) ?? window.confirm(message);
      if (!confirmed) return { status: "cancelled" };
    }
    const ids = threadIds as ReadonlyArray<ThreadId>;
    const result = isChatStateAction(action)
      ? await updateThreads({ environmentId, input: stateInput(action, ids, options) })
      : action === "delete"
        ? await deleteThreads({ environmentId, input: { threadIds: ids } })
        : await archiveThreads({
            environmentId,
            input: { threadIds: ids, archived: action === "archive" },
          });
    if (result._tag !== "Success") {
      const verb = failureVerb(action);
      return {
        status: "settled",
        notice:
          commandFailureMessage(result, `Couldn't ${verb} these chats. Try again.`) ??
          `Couldn't ${verb} these chats. Try again.`,
        failedIds: threadIds,
        anyFailed: true,
      };
    }
    const batch: PersonalBotThreadsBatchResult = result.value;
    if (action === "delete" && batch.done.length > 0) {
      // As single delete does: the cold-start snapshot would keep painting
      // these chats on an offline launch until the Chats screen rewrites it.
      const gone = new Set<string>(batch.done);
      dropChatFromSnapshot(environmentId, (row) => row.threadId !== null && gone.has(row.threadId));
    }
    if (action === "markUnread") {
      // This device must show them unread too, even one it has just had open.
      for (const threadId of batch.done) clearChatSeen(threadId);
    }
    const notice = bulkResultNotice(action, batch);
    return {
      status: "settled",
      notice: notice.text,
      failedIds: batch.failed.map((entry) => entry.threadId),
      anyFailed: notice.failed,
    };
  };
}

/** The verb in "Couldn't <verb> these chats." */
function failureVerb(action: BulkChatAction): string {
  switch (action) {
    case "delete":
      return "delete";
    case "markUnread":
      return "mark";
    case "wake":
      return "wake";
    default:
      return action;
  }
}
