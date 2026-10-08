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

/**
 * Where the owner goes when the chat he is inside is archived or deleted
 * (1.66.8): the bot's next open chat, the first of the chips that is not the
 * one going away, so pinned chats come first, then the newest activity, the
 * same order the chip row shows. Task, routine and archived chats are not
 * candidates (only the owner's own chats are `kind: "chat"`). Null when the
 * bot has no other open chat: the caller then goes to the bot's chat list, as
 * it did before.
 */
export function nextOpenChatAfterRemoval(
  chips: ReadonlyArray<{ readonly threadId: string; readonly kind: string }>,
  removedThreadId: string,
): string | null {
  return (
    chips.find((chip) => chip.kind === "chat" && chip.threadId !== removedThreadId)?.threadId ??
    null
  );
}

/** The row's open chat: the one element in the chip row that carries aria-current. */
export const CURRENT_CHIP_SELECTOR = '[aria-current="page"]';

/** The row's edge fade is this wide: a chip that must be seen sits clear of it. */
export const CHIP_EDGE_CLEARANCE = 24;

/**
 * Where to scroll the row so a chip is fully in view, or null when it already
 * is. The nearest edge wins and the chip clears the fade there; a chip that
 * moved to the front therefore lands at the row's start. Positions are the
 * chip's offsetLeft and offsetWidth against the row's scrollLeft and clientWidth.
 */
export function scrollLeftToReveal(
  row: { readonly scrollLeft: number; readonly clientWidth: number },
  chip: { readonly offsetLeft: number; readonly offsetWidth: number },
): number | null {
  const left = chip.offsetLeft;
  const right = left + chip.offsetWidth;
  const inset = Math.min(
    CHIP_EDGE_CLEARANCE,
    Math.max(0, (row.clientWidth - chip.offsetWidth) / 2),
  );
  let target: number | null = null;
  if (left - inset < row.scrollLeft) target = Math.max(0, left - inset);
  else if (right + inset > row.scrollLeft + row.clientWidth) {
    target = Math.max(0, right + inset - row.clientWidth);
  }
  return target === row.scrollLeft ? null : target;
}
