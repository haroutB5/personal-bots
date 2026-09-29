import {
  type EnvironmentId,
  PERSONAL_FILES_BATCH_MAX,
  PERSONAL_MEMORY_BATCH_MAX,
  type PersonalMemoryId,
} from "@t3tools/contracts";

import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  bulkDeleteConfirmLabel,
  bulkResultNotice,
  type BulkNoun,
  chunkIds,
  countOf,
  DELETE_VERB,
} from "./bulkSelection";
import { commandFailureMessage } from "./commandFeedback";
import { personalMemoryDeleteMany } from "./usePersonalAutomation";
import { personalFilesDeleteMany } from "./usePersonalBots";

export const FILE_NOUN: BulkNoun = { one: "file", many: "files" };
export const MEMORY_NOUN: BulkNoun = { one: "memory", many: "memories" };

/** The one confirm a bulk file delete asks, naming the count. */
export function bulkDeleteFilesConfirmMessage(count: number): string {
  return `Delete ${countOf(count, FILE_NOUN)}?\nThey'll disappear from your chats and can't be undone.`;
}

/** The one confirm a bulk memory delete asks, naming the count. */
export function bulkDeleteMemoriesConfirmMessage(count: number): string {
  return `Delete ${countOf(count, MEMORY_NOUN)}?\nBots stop receiving ${
    count === 1 ? "it" : "them"
  }. Chats where ${count === 1 ? "it was" : "they were"} mentioned still contain the text.`;
}

export type BulkDeleteOutcome =
  | { readonly status: "cancelled" }
  | {
      readonly status: "settled";
      readonly notice: string;
      /** Rows the server removed. */
      readonly doneIds: ReadonlyArray<string>;
      /** Rows the server refused or could not reach; they stay selected. */
      readonly failedIds: ReadonlyArray<string>;
      readonly anyFailed: boolean;
    };

interface BatchReply {
  readonly done: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<{ readonly id: string; readonly message: string }>;
}

/** Why a whole request failed: the server's message, else a generic line. */
function requestFailure(result: AtomCommandResult<unknown, unknown>, noun: BulkNoun): string {
  const fallback = `Couldn't delete these ${noun.many}. Try again.`;
  return commandFailureMessage(result, fallback) ?? fallback;
}

/**
 * Asks once with the count, then deletes in as few requests as the server
 * allows (one, unless the selection is larger than its batch limit). A
 * request that fails outright leaves its rows selected with its reason.
 */
async function runBulkDelete({
  ids,
  noun,
  environmentId,
  confirmMessage,
  batchMax,
  send,
}: {
  ids: ReadonlyArray<string>;
  noun: BulkNoun;
  environmentId: EnvironmentId | null;
  confirmMessage: string;
  batchMax: number;
  /** The server's reply, or the reason the whole request failed. */
  send: (
    environmentId: EnvironmentId,
    chunk: ReadonlyArray<string>,
  ) => Promise<BatchReply | string>;
}): Promise<BulkDeleteOutcome> {
  if (ids.length === 0) return { status: "cancelled" };
  if (environmentId === null) {
    return {
      status: "settled",
      notice: "Not connected to your computer.",
      doneIds: [],
      failedIds: ids,
      anyFailed: true,
    };
  }
  const confirmed =
    (await requestConfirmDialog(confirmMessage, {
      variant: "destructive",
      confirmLabel: bulkDeleteConfirmLabel(ids.length, noun),
    })) ?? window.confirm(confirmMessage);
  if (!confirmed) return { status: "cancelled" };

  const done: Array<string> = [];
  const failed: Array<{ readonly id: string; readonly message: string }> = [];
  for (const chunk of chunkIds(ids, batchMax)) {
    const reply = await send(environmentId, chunk);
    if (typeof reply === "string") {
      failed.push(...chunk.map((id) => ({ id, message: reply })));
      continue;
    }
    done.push(...reply.done);
    failed.push(...reply.failed);
  }
  const notice = bulkResultNotice(
    DELETE_VERB,
    noun,
    done.length,
    failed.map((entry) => entry.message),
  );
  return {
    status: "settled",
    notice: notice.text,
    doneIds: done,
    failedIds: failed.map((entry) => entry.id),
    anyFailed: notice.failed,
  };
}

/** Deletes a Files-tab selection in one request, each file as a single delete would. */
export function useBulkDeleteFiles(
  environmentId: EnvironmentId | null,
): (fileIds: ReadonlyArray<string>) => Promise<BulkDeleteOutcome> {
  const deleteMany = useAtomCommand(personalFilesDeleteMany, { reportFailure: false });
  return (fileIds) =>
    runBulkDelete({
      ids: fileIds,
      noun: FILE_NOUN,
      environmentId,
      confirmMessage: bulkDeleteFilesConfirmMessage(fileIds.length),
      batchMax: PERSONAL_FILES_BATCH_MAX,
      send: async (target, chunk) => {
        const result = await deleteMany({ environmentId: target, input: { fileIds: chunk } });
        if (result._tag !== "Success") return requestFailure(result, FILE_NOUN);
        return {
          done: result.value.done,
          failed: result.value.failed.map(({ fileId, message }) => ({ id: fileId, message })),
        };
      },
    });
}

/** Deletes a Memory selection in one request, each entry as a single delete would. */
export function useBulkDeleteMemories(
  environmentId: EnvironmentId | null,
): (memoryIds: ReadonlyArray<string>) => Promise<BulkDeleteOutcome> {
  const deleteMany = useAtomCommand(personalMemoryDeleteMany, { reportFailure: false });
  return (memoryIds) =>
    runBulkDelete({
      ids: memoryIds,
      noun: MEMORY_NOUN,
      environmentId,
      confirmMessage: bulkDeleteMemoriesConfirmMessage(memoryIds.length),
      batchMax: PERSONAL_MEMORY_BATCH_MAX,
      send: async (target, chunk) => {
        const result = await deleteMany({
          environmentId: target,
          input: { memoryIds: chunk as ReadonlyArray<PersonalMemoryId> },
        });
        if (result._tag !== "Success") return requestFailure(result, MEMORY_NOUN);
        return {
          done: result.value.done,
          failed: result.value.failed.map(({ memoryId, message }) => ({ id: memoryId, message })),
        };
      },
    });
}
