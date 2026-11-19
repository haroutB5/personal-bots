import type { ChatEntry } from "../nav/chatEntry";
import type { NavState } from "../nav/routes";
import { onChatPress, pressChat } from "../personal/chatPress";

export interface ChatTarget {
  readonly botId: string;
  readonly threadId: string;
  readonly requestId?: string;
  readonly via?: ChatEntry | undefined;
}

interface NavigatesToChat {
  navigate(name: "Chat", params: ChatTarget): void;
}

interface ReplacesWithChat {
  replace(name: "Chat", params: ChatTarget): void;
}

export function openChat(navigator: NavigatesToChat, target: ChatTarget): void {
  pressChat(target.threadId, () => navigator.navigate("Chat", target));
}

export function replaceWithChat(navigator: ReplacesWithChat, target: ChatTarget): void {
  pressChat(target.threadId, () => navigator.replace("Chat", target));
}

/**
 * A link that lands on a chat (a notification tap) starts that chat's request when it is
 * received, before the navigator is ready and before the screen mounts.
 */
export function warmLinkedChat(state: NavState): void {
  const top = state.stack[state.stack.length - 1];
  if (top?.kind === "chat") onChatPress(top.threadId);
}
