import type { StartChatResult } from "../chat/useStartChat";

/** How the New chat screen gets from "opened" to "a chat exists". */
export type NewChatStart =
  | { readonly kind: "waiting"; readonly failures: number }
  | { readonly kind: "starting"; readonly failures: number }
  | { readonly kind: "started"; readonly threadId: string }
  | { readonly kind: "failed"; readonly message: string };

export type NewChatEvent =
  | { readonly type: "inputs"; readonly connected: boolean; readonly hasTarget: boolean }
  | { readonly type: "result"; readonly result: StartChatResult };

/** Stub of the old behaviour: it starts once and shows any failure. */
export const MAX_START_FAILURES = 3;

export const NEW_CHAT_INITIAL: NewChatStart = { kind: "waiting", failures: 0 };

export function stepNewChat(state: NewChatStart, event: NewChatEvent): NewChatStart {
  if (event.type === "inputs") {
    if (state.kind === "waiting" && event.hasTarget) {
      return { kind: "starting", failures: state.failures };
    }
    return state;
  }
  if (state.kind !== "starting") return state;
  if (event.result.kind === "started") return { kind: "started", threadId: event.result.threadId };
  return { kind: "failed", message: event.result.message };
}
