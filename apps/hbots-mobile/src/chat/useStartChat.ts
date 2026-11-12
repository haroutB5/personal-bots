import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { ThreadId } from "@t3tools/contracts";

import type { NativePersonal } from "../personal/nativePersonalClient";

/**
 * How a start ended, as the screens need it. No variant carries error text: a dropped link is
 * `interrupted` or `unreachable`, and anything the server or the client refused is `rejected`.
 */
export type StartChatResult =
  | { readonly kind: "started"; readonly threadId: string }
  | { readonly kind: "interrupted" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "rejected" };

// Chats started in this app run: the chat screen draws their chip before the list knows them.
const startedChats = new Set<string>();

export function markChatStarted(threadId: string): void {
  startedChats.add(threadId);
}

export function wasChatStartedHere(threadId: string): boolean {
  return startedChats.has(threadId);
}

function failedStartResult(error: unknown): StartChatResult {
  return error instanceof Error && isTransportConnectionErrorMessage(error.message)
    ? { kind: "unreachable" }
    : { kind: "rejected" };
}

export function startChatResult(
  threadId: string,
  result: AtomCommandResult<unknown, unknown>,
): StartChatResult {
  if (result._tag === "Success") {
    markChatStarted(threadId);
    return { kind: "started", threadId };
  }
  if (isAtomCommandInterrupted(result)) return { kind: "interrupted" };
  return failedStartResult(squashAtomCommandFailure(result));
}

/**
 * Creates a new chat with a bot. The caller decides what to open or queue next. The server creates a
 * chat once per `threadId`, so a caller that asks again after a lost reply passes the same one.
 */
export function useStartChat(
  native: NativePersonal,
): (
  botId: string,
  options?: { readonly title?: string; readonly threadId?: string },
) => Promise<StartChatResult> {
  const create = native.client.useAtomCommand(native.bots.personalBotCreateThread, {
    reportFailure: false,
  });
  return async (botId, options) => {
    const threadId = options?.threadId ?? native.client.ports.ids.randomUUID();
    try {
      const result = await create({
        environmentId: native.environmentId,
        input: {
          botId: botId as never,
          threadId: ThreadId.make(threadId),
          ...(options?.title === undefined ? {} : { title: options.title }),
        },
      });
      return startChatResult(threadId, result);
    } catch (error) {
      return failedStartResult(error);
    }
  };
}
