/** Fits the chat above the Android IME without moving the composer. */

/** List top padding, card margins and list bottom padding around one row. */
export const CHAT_CARD_CHROME = 32;
/** The list's visual bottom padding and the card's bottom margin. */
export const CHAT_CARD_BOTTOM_GAP = 12;

export interface ChatKeyboardLayout {
  readonly keyboardOpen: boolean;
  readonly dockVisible: boolean;
  /** Body-relative y of the bottom of the list's visible area. */
  readonly listBottom: number;
  /** Body-relative y of the top of the keyboard. */
  readonly keyboardTop: number;
  /** Body-relative y of the dock's top while it is shown. */
  readonly dockTop: number | null;
  /** Body-relative y of a card that fills the list, leaving its bottom margin. */
  readonly cardBottom: number;
  /** A card row taller than this no longer fits above the obstacles. */
  readonly cardMaxHeight: number;
}

export function chatKeyboardLayout(input: {
  readonly bodyHeight: number;
  readonly keyboardInset: number;
  readonly keyboardOpen: boolean;
  readonly composerHeight: number;
  readonly dockHeight: number;
  readonly listHeight: number;
}): ChatKeyboardLayout {
  const dockVisible = !input.keyboardOpen;
  const bottomBar = input.composerHeight + (dockVisible ? input.dockHeight : 0);
  const listBottom = Math.max(0, input.bodyHeight - input.keyboardInset - bottomBar);
  return {
    keyboardOpen: input.keyboardOpen,
    dockVisible,
    listBottom,
    keyboardTop: Math.max(0, input.bodyHeight - input.keyboardInset),
    dockTop: dockVisible ? listBottom : null,
    cardBottom: Math.max(0, listBottom - CHAT_CARD_BOTTOM_GAP),
    cardMaxHeight: Math.max(0, input.listHeight - CHAT_CARD_CHROME),
  };
}
