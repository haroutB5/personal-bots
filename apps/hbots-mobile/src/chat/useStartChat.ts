import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ThreadId } from "@t3tools/contracts";

import type { NativePersonal } from "../personal/nativePersonalClient";

export type StartChatResult =
  | { readonly kind: "started"; readonly threadId: string }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Creates a new chat with a bot. The caller decides what to open or queue next.
 * Pass `threadId` to retry with the same id, so one chat is created however many attempts it takes.
 */
export function useStartChat(
  native: NativePersonal,
): (botId: string, title?: string, threadId?: string) => Promise<StartChatResult> {
  const create = native.client.useAtomCommand(native.bots.personalBotCreateThread, {
    reportFailure: false,
  });
  return async (botId, title, existingThreadId) => {
    const threadId = existingThreadId ?? native.client.ports.ids.randomUUID();
    try {
      const result = await create({
        environmentId: native.environmentId,
        input: {
          botId: botId as never,
          threadId: ThreadId.make(threadId),
          ...(title === undefined ? {} : { title }),
        },
      });
      if (result._tag === "Success") return { kind: "started", threadId };
      const cause = squashAtomCommandFailure(result);
      return {
        kind: "failed",
        message: cause instanceof Error ? cause.message : "Couldn't start a chat. Try again.",
      };
    } catch {
      return { kind: "failed", message: "Couldn't start a chat. Try again." };
    }
  };
}
