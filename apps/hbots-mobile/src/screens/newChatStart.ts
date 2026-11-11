import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime/errors";

import type { StartChatResult } from "../chat/useStartChat";

/**
 * How the New chat screen gets from "opened" to "a chat exists". It starts only on a connected link.
 * When the link drops under a start (a warm launch meets the socket the app is still re-opening) the
 * start is not a failure: it waits for the link and goes again, a few times at most.
 */
export type NewChatStart =
  /** Not started: no target bot yet, or no connected link. `failures` counts the starts the link dropped under. */
  | { readonly kind: "waiting"; readonly failures: number }
  | { readonly kind: "starting"; readonly failures: number }
  | { readonly kind: "started"; readonly threadId: string }
  | { readonly kind: "failed"; readonly message: string };

export type NewChatEvent =
  | { readonly type: "inputs"; readonly connected: boolean; readonly hasTarget: boolean }
  | { readonly type: "result"; readonly result: StartChatResult };

/** Starts the link dropped under before the screen shows the error. */
export const MAX_START_FAILURES = 3;

/** How long to wait before a start that the link dropped under goes again on a link that says it is up. */
export const NEW_CHAT_RETRY_MS = 1_500;

export const NEW_CHAT_INITIAL: NewChatStart = { kind: "waiting", failures: 0 };

export function stepNewChat(state: NewChatStart, event: NewChatEvent): NewChatStart {
  if (event.type === "inputs") {
    if (state.kind === "waiting" && event.hasTarget && event.connected) {
      return { kind: "starting", failures: state.failures };
    }
    return state;
  }
  if (state.kind !== "starting") return state;
  const { result } = event;
  if (result.kind === "started") return { kind: "started", threadId: result.threadId };
  const failures = state.failures + 1;
  if (isTransportConnectionErrorMessage(result.message) && failures < MAX_START_FAILURES) {
    return { kind: "waiting", failures };
  }
  return { kind: "failed", message: result.message };
}
