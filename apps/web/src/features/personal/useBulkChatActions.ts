import type { EnvironmentId, PersonalBotThreadsBatchResult, ThreadId } from "@t3tools/contracts";

import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";

import { dropChatFromSnapshot } from "./chatsSnapshot";
import {
  bulkDeleteConfirmLabel,
  bulkDeleteConfirmMessage,
  bulkResultNotice,
  type BulkChatAction,
} from "./chatSelection";
import { commandFailureMessage } from "./commandFeedback";
import { personalBotArchiveThreads, personalBotDeleteThreads } from "./usePersonalBots";

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
 * Archive, unarchive or delete a selection in one request. The server runs
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
) => Promise<BulkChatOutcome> {
  const archiveThreads = useAtomCommand(personalBotArchiveThreads, { reportFailure: false });
  const deleteThreads = useAtomCommand(personalBotDeleteThreads, { reportFailure: false });
  return async (action, threadIds, workingCount) => {
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
    const result =
      action === "delete"
        ? await deleteThreads({ environmentId, input: { threadIds: ids } })
        : await archiveThreads({
            environmentId,
            input: { threadIds: ids, archived: action === "archive" },
          });
    if (result._tag !== "Success") {
      const verb = action === "delete" ? "delete" : action;
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
    const notice = bulkResultNotice(action, batch);
    return {
      status: "settled",
      notice: notice.text,
      failedIds: batch.failed.map((entry) => entry.threadId),
      anyFailed: notice.failed,
    };
  };
}
