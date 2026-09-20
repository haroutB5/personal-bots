import { useCallback, useState } from "react";

import { WRAPUP_CHAT_PROMPT } from "@t3tools/contracts";
import type { EnvironmentId, MessageId, ModelSelection, ThreadId } from "@t3tools/contracts";

import { newMessageId } from "~/lib/utils";
import { threadEnvironment } from "~/state/threads";
import type { Thread } from "~/types";
import { useAtomCommand } from "~/state/use-atom-command";

export { WRAPUP_CHAT_PROMPT };

/**
 * Builds the `thread.turn.start` input for a wrapup turn. Pure (message id
 * and timestamp are parameters) so the send shape is unit-testable. Field
 * selection mirrors `PersonalComposer`: the bot's current model settings win
 * when it is still on the same provider instance, and the existing title is
 * kept so a wrapup never renames the chat.
 */
export function buildWrapupTurnInput({
  threadId,
  thread,
  botModelSelection,
  messageId,
  createdAt,
}: {
  threadId: ThreadId;
  thread: Thread;
  botModelSelection: ModelSelection | null;
  messageId: MessageId;
  createdAt: string;
}) {
  return {
    threadId,
    message: {
      messageId,
      role: "user" as const,
      text: WRAPUP_CHAT_PROMPT,
      attachments: [],
    },
    modelSelection:
      botModelSelection !== null &&
      botModelSelection.instanceId === thread.modelSelection.instanceId
        ? botModelSelection
        : thread.modelSelection,
    titleSeed: thread.title,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    createdAt,
  };
}

/**
 * Sends the canned wrapup turn to an already-loaded thread. Resolves true
 * when the turn started; the caller navigates so the user watches it happen.
 */
export function useWrapupChat(
  environmentId: EnvironmentId | null,
  thread: Thread | null,
  botModelSelection: ModelSelection | null,
): { send: () => Promise<boolean>; sending: boolean } {
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [sending, setSending] = useState(false);

  const send = useCallback(async () => {
    if (environmentId === null || thread === null || sending) return false;
    setSending(true);
    try {
      const result = await startTurn({
        environmentId,
        input: buildWrapupTurnInput({
          threadId: thread.id,
          thread,
          botModelSelection,
          messageId: newMessageId(),
          createdAt: new Date().toISOString(),
        }),
      });
      return result._tag === "Success";
    } catch {
      return false;
    } finally {
      setSending(false);
    }
  }, [botModelSelection, environmentId, sending, startTurn, thread]);

  return { send, sending };
}
