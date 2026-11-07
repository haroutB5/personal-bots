/**
 * How much of the keyboard still covers a container after the window resize
 * took its share. Android 16 edge-to-edge keeps the window full height, so
 * the whole keyboard is left; a window that did resize leaves nothing.
 */
export function keyboardRemainder(input: {
  readonly baseHeight: number;
  readonly frameHeight: number;
  readonly keyboardHeight: number;
}): number {
  if (input.keyboardHeight <= 0 || input.baseHeight <= 0 || input.frameHeight <= 0) return 0;
  const shrunk = Math.max(0, input.baseHeight - input.frameHeight);
  return Math.max(0, input.keyboardHeight - shrunk);
}

/**
 * The container height measured with the keyboard closed. It is only ever
 * replaced by a closed-keyboard layout, never cleared when the keyboard
 * hides: an edge-to-edge window does not lay out again on hide, so a cleared
 * value would stay empty and every later keyboard would get no padding.
 */
export function nextBaseHeight(input: {
  readonly previous: number | null;
  readonly layoutHeight: number;
  readonly keyboardOpen: boolean;
}): number | null {
  if (input.keyboardOpen) return input.previous;
  return input.layoutHeight > 0 ? input.layoutHeight : input.previous;
}
