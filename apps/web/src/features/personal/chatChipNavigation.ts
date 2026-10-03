/**
 * Where a chat chip goes. Switching REPLACES the history entry, so it never
 * stacks: Back from any chat is still one tap, to /bots, or to /bots/team when
 * the chat was opened from the Team screen. The current state rides along, and
 * botsBackStack.ts keeps its Back marker (and the Team screen's view) on the
 * replacing entry: the Back rule is the same whichever chat is open.
 */
export function chatSwitchNavigation(botId: string, threadId: string) {
  return {
    to: "/bots/$botId/$threadId",
    params: { botId, threadId },
    replace: true,
    state: <State extends object>(previous: State) => previous,
  } as const;
}
