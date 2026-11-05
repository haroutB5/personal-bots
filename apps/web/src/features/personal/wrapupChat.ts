import { useCallback, useState } from "react";

import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { buildWrapupTurnInput } from "@hbots/personal-client/bots/wrapupChat";

import { newMessageId } from "~/lib/utils";
import { threadEnvironment } from "~/state/threads";
import type { Thread } from "~/types";
import { useAtomCommand } from "~/state/use-atom-command";

export { buildWrapupTurnInput, WRAPUP_CHAT_PROMPT } from "@hbots/personal-client/bots/wrapupChat";

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
