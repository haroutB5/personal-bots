/**
 * Keeps the keyboard up when the owner switches chats while typing.
 *
 * Every chat has its own composer (PersonalComposer is keyed by the thread),
 * so switching drops the focused field. The chat chips note that the field
 * had focus when the tap began; the next composer to mount takes the focus
 * back, so the keyboard stays and the old chat's draft stays in its chat.
 * The request expires, so a late mount (a chat that is still loading, a
 * failed switch) never steals focus long after the tap.
 */

/** Marks the composer's message field, so a tap elsewhere can tell it holds focus. */
export const COMPOSER_INPUT_ATTRIBUTE = "data-chat-composer-input";

const REFOCUS_WINDOW_MS = 3_000;

let requestedUntil = 0;

/** True while the message field holds focus (a chip tap should not take it). */
export function composerHasFocus(doc: Pick<Document, "activeElement"> = document): boolean {
  return doc.activeElement?.hasAttribute(COMPOSER_INPUT_ATTRIBUTE) ?? false;
}

export function requestComposerRefocus(nowMs: number = Date.now()): void {
  requestedUntil = nowMs + REFOCUS_WINDOW_MS;
}

/** Whether a fresh composer should take focus now. Reads once: the request is spent. */
export function consumeComposerRefocus(nowMs: number = Date.now()): boolean {
  const wanted = nowMs <= requestedUntil;
  requestedUntil = 0;
  return wanted;
}
