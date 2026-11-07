import {
  MessageId,
  ThreadId,
  botEffectiveModelSelection,
  type PersonalBot,
} from "@t3tools/contracts";
import { buildWrapupTurnInput } from "@hbots/personal-client/bots/wrapupChat";
import { useCallback, useState } from "react";

import { useThreadDetailView, useThreadRef, type ChatEnvironment } from "../chat/chatEnvironment";
import type { NativePersonal } from "../personal/nativePersonalClient";

export interface WrapupChat {
  /** The newest chat is loaded and ready to take the turn. */
  readonly ready: boolean;
  readonly sending: boolean;
  /** Resolves true when the turn started; the caller opens the chat so the owner watches it. */
  readonly send: () => Promise<boolean>;
}

/** Sends the canned wrapup turn to the bot's newest open chat. */
export function useWrapupChat(
  native: NativePersonal,
  chat: ChatEnvironment,
  bot: PersonalBot | null,
  threadId: string | null,
): WrapupChat {
  const ref = useThreadRef(native.environmentId, threadId);
  const { thread } = useThreadDetailView(chat, ref);
  const startTurn = native.client.useAtomCommand(chat.thread.startTurn, { reportFailure: false });
  const [sending, setSending] = useState(false);

  const send = useCallback(async () => {
    if (thread === null || threadId === null || sending) return false;
    setSending(true);
    try {
      const result = await startTurn({
        environmentId: native.environmentId,
        input: buildWrapupTurnInput({
          threadId: ThreadId.make(threadId),
          thread,
          botModelSelection: bot === null ? null : botEffectiveModelSelection(bot),
          messageId: MessageId.make(native.client.ports.ids.randomUUID()),
          createdAt: new Date().toISOString(),
        }),
      });
      return result._tag === "Success";
    } catch {
      return false;
    } finally {
      setSending(false);
    }
  }, [bot, native, sending, startTurn, thread, threadId]);

  return { ready: thread !== null, sending, send };
}
