import type { StartChatResult } from "../chat/useStartChat";

/**
 * How the New chat screen gets from "opened" to "a chat exists". It starts only on a connected link.
 * When the link drops under a start (a warm launch meets the socket the app is still re-opening) the
 * start is not a failure: it waits for the link and goes again, a few times at most. No state holds
 * error text, so the screen can only show the copy below.
 */
export type NewChatStart =
  /** Not started: no target bot yet, or no connected link. `failures` counts the starts the link dropped under. */
  | { readonly kind: "waiting"; readonly failures: number }
  | { readonly kind: "starting"; readonly failures: number }
  | { readonly kind: "started"; readonly threadId: string }
  | { readonly kind: "offline" }
  | { readonly kind: "failed" };

export type NewChatEvent =
  | { readonly type: "inputs"; readonly connected: boolean; readonly hasTarget: boolean }
  | { readonly type: "result"; readonly result: StartChatResult }
  | { readonly type: "timeout" }
  | { readonly type: "retry" };

export const NEW_CHAT_OFFLINE_MESSAGE = "Can't reach your laptop. It may be off or restarting.";
export const NEW_CHAT_FAILED_MESSAGE = "Couldn't start a chat. Try again.";

/** Starts the link dropped under before the screen shows the error. */
export const MAX_START_FAILURES = 3;

/** How long to wait before a start that the link dropped under goes again on a link that says it is up. */
export const NEW_CHAT_RETRY_MS = 1_500;

/** How long a start may wait for its reply before it counts as dropped under. */
export const NEW_CHAT_START_TIMEOUT_MS = 15_000;

export const NEW_CHAT_INITIAL: NewChatStart = { kind: "waiting", failures: 0 };

function dropped(state: Extract<NewChatStart, { kind: "starting" }>): NewChatStart {
  const failures = state.failures + 1;
  return failures < MAX_START_FAILURES ? { kind: "waiting", failures } : { kind: "offline" };
}

export function stepNewChat(state: NewChatStart, event: NewChatEvent): NewChatStart {
  if (event.type === "retry") {
    return state.kind === "offline" || state.kind === "failed" ? NEW_CHAT_INITIAL : state;
  }
  if (event.type === "inputs") {
    if (state.kind === "offline" && !event.connected) return NEW_CHAT_INITIAL;
    if (state.kind === "waiting" && event.hasTarget && event.connected) {
      return { kind: "starting", failures: state.failures };
    }
    return state;
  }
  if (state.kind !== "starting") return state;
  if (event.type === "timeout") return dropped(state);
  const { result } = event;
  switch (result.kind) {
    case "started":
      return { kind: "started", threadId: result.threadId };
    case "interrupted":
    case "unreachable":
      return dropped(state);
    case "rejected":
      return { kind: "failed" };
    default:
      return result satisfies never;
  }
}

/** The one sentence the screen may show for a state, or null while there is nothing to say. */
export function newChatMessage(state: NewChatStart): string | null {
  switch (state.kind) {
    case "offline":
      return NEW_CHAT_OFFLINE_MESSAGE;
    case "failed":
      return NEW_CHAT_FAILED_MESSAGE;
    case "waiting":
    case "starting":
    case "started":
      return null;
    default:
      return state satisfies never;
  }
}
