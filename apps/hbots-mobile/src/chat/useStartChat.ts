import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { ThreadId } from "@t3tools/contracts";

import type { NativePersonal } from "../personal/nativePersonalClient";

export type StartChatResult =
  | { readonly kind: "started"; readonly threadId: string }
  | { readonly kind: "interrupted" }
  | { readonly kind: "failed"; readonly message: string };

export function startChatResult(
  threadId: string,
  result: AtomCommandResult<unknown, unknown>,
): StartChatResult {
  if (result._tag === "Success") return { kind: "started", threadId };
  if (isAtomCommandInterrupted(result)) return { kind: "interrupted" };
  const cause = squashAtomCommandFailure(result);
  return {
    kind: "failed",
    message: cause instanceof Error ? cause.message : "Couldn't start a chat. Try again.",
  };
}

/** Creates a new chat with a bot. The caller decides what to open or queue next. */
export function useStartChat(
  native: NativePersonal,
): (botId: string, title?: string) => Promise<StartChatResult> {
  const create = native.client.useAtomCommand(native.bots.personalBotCreateThread, {
    reportFailure: false,
  });
  return async (botId, title) => {
    const threadId = native.client.ports.ids.randomUUID();
    try {
      const result = await create({
        environmentId: native.environmentId,
        input: {
          botId: botId as never,
          threadId: ThreadId.make(threadId),
          ...(title === undefined ? {} : { title }),
        },
      });
      return startChatResult(threadId, result);
    } catch {
      return { kind: "failed", message: "Couldn't start a chat. Try again." };
    }
  };
}
