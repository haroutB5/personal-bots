import {
  type EnvironmentId,
  PERSONAL_FILES_BATCH_MAX,
  PERSONAL_LOGINS_BATCH_MAX,
  PERSONAL_MEMORY_BATCH_MAX,
  PERSONAL_ROUTINES_BATCH_MAX,
  type PersonalLoginId,
  type PersonalMemoryId,
  type PersonalRoutineId,
} from "@t3tools/contracts";

import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  bulkDeleteConfirmLabel,
  bulkResultNotice,
  type BulkNoun,
  type BulkVerb,
  chunkIds,
  countOf,
  DELETE_VERB,
} from "./bulkSelection";
import { commandFailureMessage } from "./commandFeedback";
import {
  personalMemoryDeleteMany,
  personalRoutinesDeleteMany,
  personalRoutinesSetEnabledMany,
} from "./usePersonalAutomation";
import { personalFilesDeleteMany } from "./usePersonalBots";
import { personalLoginsDeleteMany } from "./usePersonalLogins";

export const FILE_NOUN: BulkNoun = { one: "file", many: "files" };
export const MEMORY_NOUN: BulkNoun = { one: "memory", many: "memories" };
export const ROUTINE_NOUN: BulkNoun = { one: "routine", many: "routines" };
export const LOGIN_NOUN: BulkNoun = { one: "saved login", many: "saved logins" };

const PAUSE_VERB: BulkVerb = { done: "Paused", failed: "paused" };
const RESUME_VERB: BulkVerb = { done: "Resumed", failed: "resumed" };

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

/** The one confirm a bulk routine delete asks, naming the count (as the single delete words it). */
export function bulkDeleteRoutinesConfirmMessage(count: number): string {
  return `Delete ${countOf(count, ROUTINE_NOUN)}?\nTasks ${
    count === 1 ? "it" : "they"
  } already started stay in Tasks.`;
}

/** The one confirm a bulk saved-login delete asks, naming the count. */
export function bulkDeleteLoginsConfirmMessage(count: number): string {
  return `Delete ${countOf(count, LOGIN_NOUN)}?\nBots won't be able to sign in to ${
    count === 1 ? "this site" : "these sites"
  }.`;
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
function requestFailure(
  result: AtomCommandResult<unknown, unknown>,
  noun: BulkNoun,
  action = "delete",
): string {
  const fallback = `Couldn't ${action} these ${noun.many}. Try again.`;
  return commandFailureMessage(result, fallback) ?? fallback;
}

/**
 * Asks once with the count (a delete; Pause and Resume don't ask), then runs
 * the action in as few requests as the server allows (one, unless the
 * selection is larger than its batch limit). A request that fails outright
 * leaves its rows selected with its reason.
 */
async function runBulkDelete({
  ids,
  noun,
  environmentId,
  confirmMessage,
  verb = DELETE_VERB,
  batchMax,
  send,
}: {
  ids: ReadonlyArray<string>;
  noun: BulkNoun;
  environmentId: EnvironmentId | null;
  /** Null for an action that needs no confirm. */
  confirmMessage: string | null;
  verb?: BulkVerb;
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
  if (confirmMessage !== null) {
    const confirmed =
      (await requestConfirmDialog(confirmMessage, {
        variant: "destructive",
        confirmLabel: bulkDeleteConfirmLabel(ids.length, noun),
      })) ?? window.confirm(confirmMessage);
    if (!confirmed) return { status: "cancelled" };
  }

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
    verb,
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

/** Deletes a Routines selection in one request, each routine as a single delete would. */
export function useBulkDeleteRoutines(
  environmentId: EnvironmentId | null,
): (routineIds: ReadonlyArray<string>) => Promise<BulkDeleteOutcome> {
  const deleteMany = useAtomCommand(personalRoutinesDeleteMany, { reportFailure: false });
  return (routineIds) =>
    runBulkDelete({
      ids: routineIds,
      noun: ROUTINE_NOUN,
      environmentId,
      confirmMessage: bulkDeleteRoutinesConfirmMessage(routineIds.length),
      batchMax: PERSONAL_ROUTINES_BATCH_MAX,
      send: async (target, chunk) => {
        const result = await deleteMany({
          environmentId: target,
          input: { routineIds: chunk as ReadonlyArray<PersonalRoutineId> },
        });
        if (result._tag !== "Success") return requestFailure(result, ROUTINE_NOUN);
        return {
          done: result.value.done,
          failed: result.value.failed.map(({ routineId, message }) => ({ id: routineId, message })),
        };
      },
    });
}

/** Pauses or resumes a Routines selection in one request, no confirm (each undoes the other). */
export function useBulkSetRoutinesEnabled(
  environmentId: EnvironmentId | null,
): (routineIds: ReadonlyArray<string>, enabled: boolean) => Promise<BulkDeleteOutcome> {
  const setEnabledMany = useAtomCommand(personalRoutinesSetEnabledMany, { reportFailure: false });
  return (routineIds, enabled) =>
    runBulkDelete({
      ids: routineIds,
      noun: ROUTINE_NOUN,
      environmentId,
      confirmMessage: null,
      verb: enabled ? RESUME_VERB : PAUSE_VERB,
      batchMax: PERSONAL_ROUTINES_BATCH_MAX,
      send: async (target, chunk) => {
        const result = await setEnabledMany({
          environmentId: target,
          input: { routineIds: chunk as ReadonlyArray<PersonalRoutineId>, enabled },
        });
        if (result._tag !== "Success") {
          return requestFailure(result, ROUTINE_NOUN, enabled ? "resume" : "pause");
        }
        return {
          done: result.value.done,
          failed: result.value.failed.map(({ routineId, message }) => ({ id: routineId, message })),
        };
      },
    });
}

/** Deletes a Saved logins selection in one request, each login as a single delete would. */
export function useBulkDeleteLogins(
  environmentId: EnvironmentId | null,
): (loginIds: ReadonlyArray<string>) => Promise<BulkDeleteOutcome> {
  const deleteMany = useAtomCommand(personalLoginsDeleteMany, { reportFailure: false });
  return (loginIds) =>
    runBulkDelete({
      ids: loginIds,
      noun: LOGIN_NOUN,
      environmentId,
      confirmMessage: bulkDeleteLoginsConfirmMessage(loginIds.length),
      batchMax: PERSONAL_LOGINS_BATCH_MAX,
      send: async (target, chunk) => {
        const result = await deleteMany({
          environmentId: target,
          input: { loginIds: chunk as ReadonlyArray<PersonalLoginId> },
        });
        if (result._tag !== "Success") return requestFailure(result, LOGIN_NOUN);
        return {
          done: result.value.done,
          failed: result.value.failed.map(({ loginId, message }) => ({ id: loginId, message })),
        };
      },
    });
}
