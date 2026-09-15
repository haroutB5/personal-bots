import type { EnvironmentId, PersonalFile } from "@t3tools/contracts";

import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage, type DestructiveOutcome } from "./commandFeedback";
import { personalFileDelete } from "./usePersonalBots";

/** Confirm copy shared by the swipe action and preview sheet. */
export function deleteFileConfirmMessage(fileName: string): string {
  return `Delete ${fileName} permanently?\nThe file will disappear from your chats and can't be undone.`;
}

/** Asks for confirmation, then permanently deletes one stored chat attachment. */
export function useDeleteFile(
  environmentId: EnvironmentId | null,
): (file: Pick<PersonalFile, "fileId" | "name">) => Promise<DestructiveOutcome> {
  const deleteFile = useAtomCommand(personalFileDelete);
  return async (file) => {
    if (environmentId === null) {
      return { status: "failed", message: "Not connected to your computer." };
    }
    const message = deleteFileConfirmMessage(file.name);
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return { status: "cancelled" };
    const result = await deleteFile({ environmentId, input: { fileId: file.fileId } });
    const failure = commandFailureMessage(result, "Couldn't delete this file. Try again.");
    return failure === null ? { status: "done" } : { status: "failed", message: failure };
  };
}
