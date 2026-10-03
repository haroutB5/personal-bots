import { useCallback, useState } from "react";

import type { EnvironmentId, PersonalBotId } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import { personalBotCreateThread } from "./usePersonalBots";

export interface StartBotChatOptions {
  /**
   * Swap the current history entry for the new chat (leaving a chat for its
   * replacement), instead of adding one.
   */
  readonly replace?: boolean;
  /** Carry the current history state to the new chat (the chat chips: Back keeps its origin). */
  readonly keepState?: boolean;
  /** Runs once the chat exists and before it opens (naming it, so it never shows "New chat" first). */
  readonly onCreated?: (threadId: ThreadId) => Promise<unknown>;
}

/**
 * Starts a new chat with a bot and opens it. The thread id is generated on the
 * client, so a retried create is idempotent server-side.
 */
export function useStartBotChat(environmentId: EnvironmentId | null, botId: PersonalBotId | null) {
  const navigate = useNavigate();
  const createThread = useAtomCommand(personalBotCreateThread);
  const [starting, setStarting] = useState(false);

  const start = useCallback(
    async (options?: StartBotChatOptions) => {
      if (environmentId === null || botId === null || starting) return;
      setStarting(true);
      const threadId = ThreadId.make(randomUUID());
      const result = await createThread({ environmentId, input: { botId, threadId } });
      if (result._tag === "Success") await options?.onCreated?.(threadId);
      setStarting(false);
      if (result._tag === "Success") {
        await navigate({
          to: "/bots/$botId/$threadId",
          params: { botId, threadId },
          replace: options?.replace ?? false,
          ...(options?.keepState === true ? { state: (previous) => previous } : {}),
        });
      }
    },
    [botId, createThread, environmentId, navigate, starting],
  );

  return { start, starting };
}
