import { useCallback, useRef, useState } from "react";

import type { EnvironmentId, PersonalBotId } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import { isChatNameTakenFailure } from "./chatNames";
import { commandFailureMessage } from "./commandFeedback";
import { personalBotCreateThread } from "./usePersonalBots";

export interface StartBotChatOptions {
  /**
   * Swap the current history entry for the new chat (leaving a chat for its
   * replacement), instead of adding one.
   */
  readonly replace?: boolean;
  /** Carry the current history state to the new chat (the chat chips: Back keeps its origin). */
  readonly keepState?: boolean;
  /** Runs once the chat exists and before it opens. */
  readonly onCreated?: (threadId: ThreadId) => Promise<unknown>;
  /**
   * The name the owner typed: the chat is created with it, so it never shows
   * "New chat". The server refuses it when another open chat of the bot has it.
   */
  readonly title?: string;
}

/** What starting a chat came to: it opened, or the server said why not. */
export type StartBotChatOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly nameTaken: boolean };

/**
 * Starts a new chat with a bot and opens it. The thread id is generated on the
 * client, so a retried create is idempotent server-side.
 */
export function useStartBotChat(environmentId: EnvironmentId | null, botId: PersonalBotId | null) {
  const navigate = useNavigate();
  const createThread = useAtomCommand(personalBotCreateThread, { reportFailure: false });
  const [starting, setStarting] = useState(false);
  // The state above lags a tap behind: two quick taps must still make one chat.
  const inFlight = useRef(false);

  const start = useCallback(
    async (options?: StartBotChatOptions): Promise<StartBotChatOutcome> => {
      if (environmentId === null || botId === null || inFlight.current) {
        return { ok: false, message: "Couldn't start the chat. Try again.", nameTaken: false };
      }
      inFlight.current = true;
      setStarting(true);
      const threadId = ThreadId.make(randomUUID());
      const result = await createThread({
        environmentId,
        input: {
          botId,
          threadId,
          ...(options?.title === undefined ? {} : { title: options.title }),
        },
      });
      if (result._tag === "Success") await options?.onCreated?.(threadId);
      inFlight.current = false;
      setStarting(false);
      if (result._tag !== "Success") {
        return {
          ok: false,
          message: commandFailureMessage(result, "Couldn't start the chat. Try again.") ?? "",
          nameTaken: isChatNameTakenFailure(result),
        };
      }
      await navigate({
        to: "/bots/$botId/$threadId",
        params: { botId, threadId },
        replace: options?.replace ?? false,
        ...(options?.keepState === true ? { state: (previous) => previous } : {}),
      });
      return { ok: true };
    },
    [botId, createThread, environmentId, navigate],
  );

  return { start, starting };
}
