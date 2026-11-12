export const JUMP_THRESHOLD = 80;
export const JUMP_SETTLE_MS = 150;

/** In the inverted list, scrolling up is a positive offset from the newest message. */
export function jumpVisible(offsetY: number): boolean {
  return offsetY > JUMP_THRESHOLD;
}
