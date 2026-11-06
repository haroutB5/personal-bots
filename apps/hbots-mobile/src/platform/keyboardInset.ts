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
