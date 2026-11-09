import { ThreadId, type PersonalBotThreadsBatchResult } from "@t3tools/contracts";
import {
  BULK_NOT_CONNECTED_NOTICE,
  bulkChatFailureFallback,
  bulkChatStateInput,
  type BulkChatOptions,
  type BulkChatOutcome,
} from "@hbots/personal-client/bots/bulkChatActions";
import {
  chatActionFailure,
  deleteChatConfirmMessage,
} from "@hbots/personal-client/bots/chatActionText";
import { dropChatFromSnapshot } from "@hbots/personal-client/bots/chatsSnapshot";
import {
  bulkDeleteConfirmLabel,
  bulkDeleteConfirmMessage,
  bulkResultNotice,
  isChatStateAction,
  unarchiveRenamedNotice,
  type BulkChatAction,
} from "@hbots/personal-client/bots/chatSelection";
import { commandFailureMessage } from "@hbots/personal-client/bots/commandFeedback";
import { clearChatSeen } from "@hbots/personal-client/bots/unreadChats";

import { confirmDestructive } from "../components/confirmDestructive";
import type { NativePersonal } from "../personal/nativePersonalClient";

export type ChatActionOutcome =
  | { readonly status: "done"; readonly notice: string | null }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly message: string };

export interface ThreadActions {
  readonly runBulk: (
    action: BulkChatAction,
    threadIds: ReadonlyArray<string>,
    workingCount: number,
    options?: BulkChatOptions,
  ) => Promise<BulkChatOutcome>;
  readonly setArchived: (
    threadId: string,
    title: string,
    archived: boolean,
  ) => Promise<ChatActionOutcome>;
  readonly deleteChat: (
    threadId: string,
    title: string,
    working: boolean,
  ) => Promise<ChatActionOutcome>;
}

/**
 * Every write the chat list makes: the bulk bar and a swiped row go through
 * one request each, the server runs each chat through the single-chat path,
 * and the list refreshes once when the batch is done. A delete asks first.
 */
export function useThreadActions(native: NativePersonal): ThreadActions {
  const archiveThreads = native.client.useAtomCommand(native.bots.personalBotArchiveThreads, {
    reportFailure: false,
  });
  const deleteThreads = native.client.useAtomCommand(native.bots.personalBotDeleteThreads, {
    reportFailure: false,
  });
  const updateThreads = native.client.useAtomCommand(native.bots.personalBotUpdateThreads, {
    reportFailure: false,
  });
  const archiveThread = native.client.useAtomCommand(native.bots.personalBotArchiveThread, {
    reportFailure: false,
  });
  const deleteThread = native.client.useAtomCommand(native.bots.personalBotDeleteThread, {
    reportFailure: false,
  });
  const environmentId = native.environmentId;
  const store = native.client.ports.kv;

  const runBulk: ThreadActions["runBulk"] = async (action, threadIds, workingCount, options) => {
    if (threadIds.length === 0) return { status: "cancelled" };
    if (action === "delete") {
      const confirmed = await confirmDestructive(
        bulkDeleteConfirmMessage(threadIds.length, workingCount),
        bulkDeleteConfirmLabel(threadIds.length),
      );
      if (!confirmed) return { status: "cancelled" };
    }
    const ids = threadIds.map((threadId) => ThreadId.make(threadId));
    try {
      const result = isChatStateAction(action)
        ? await updateThreads({
            environmentId,
            input: bulkChatStateInput(action, ids, options, Date.now()),
          })
        : action === "delete"
          ? await deleteThreads({ environmentId, input: { threadIds: ids } })
          : await archiveThreads({
              environmentId,
              input: { threadIds: ids, archived: action === "archive" },
            });
      if (result._tag !== "Success") {
        const fallback = bulkChatFailureFallback(action);
        return {
          status: "settled",
          notice: commandFailureMessage(result, fallback) ?? fallback,
          failedIds: threadIds,
          anyFailed: true,
        };
      }
      const batch: PersonalBotThreadsBatchResult = result.value;
      if (action === "delete" && batch.done.length > 0) {
        const gone = new Set<string>(batch.done);
        dropChatFromSnapshot(
          store,
          environmentId,
          (row) => row.threadId !== null && gone.has(row.threadId),
        );
      }
      if (action === "markUnread") {
        for (const threadId of batch.done) clearChatSeen(threadId);
      }
      const notice = bulkResultNotice(action, batch);
      return {
        status: "settled",
        notice: notice.text,
        failedIds: batch.failed.map((entry) => entry.threadId),
        anyFailed: notice.failed,
      };
    } catch {
      return {
        status: "settled",
        notice: BULK_NOT_CONNECTED_NOTICE,
        failedIds: threadIds,
        anyFailed: true,
      };
    }
  };

  const setArchived: ThreadActions["setArchived"] = async (threadId, title, archived) => {
    try {
      const result = await archiveThread({
        environmentId,
        input: { threadId: ThreadId.make(threadId), archived },
      });
      const failure = commandFailureMessage(
        result,
        archived
          ? "Couldn't archive this chat. Try again."
          : "Couldn't unarchive this chat. Try again.",
      );
      if (failure !== null) return { status: "failed", message: failure };
      const renamedTo = result._tag === "Success" ? result.value.renamedTo : undefined;
      return {
        status: "done",
        notice:
          !archived && renamedTo !== undefined ? unarchiveRenamedNotice(title, renamedTo) : null,
      };
    } catch {
      return {
        status: "failed",
        message: archived
          ? "Couldn't archive this chat. Try again."
          : "Couldn't unarchive this chat. Try again.",
      };
    }
  };

  const deleteChat: ThreadActions["deleteChat"] = async (threadId, title, working) => {
    const confirmed = await confirmDestructive(
      deleteChatConfirmMessage({ title, working }),
      "Delete chat",
    );
    if (!confirmed) return { status: "cancelled" };
    try {
      const result = await deleteThread({
        environmentId,
        input: { threadId: ThreadId.make(threadId) },
      });
      const reason = commandFailureMessage(result, "");
      if (reason !== null) {
        return {
          status: "failed",
          message: chatActionFailure("delete", title, reason === "" ? undefined : reason),
        };
      }
      dropChatFromSnapshot(store, environmentId, (row) => row.threadId === threadId);
      return { status: "done", notice: null };
    } catch {
      return { status: "failed", message: chatActionFailure("delete", title) };
    }
  };

  return { runBulk, setArchived, deleteChat };
}
