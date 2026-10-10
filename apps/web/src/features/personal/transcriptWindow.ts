export const TRANSCRIPT_WINDOW_SIZE = 80;
export const TRANSCRIPT_WINDOW_STEP = 40;

/** Keep a reader's page by identity when older data is prepended or replies arrive. */
export function transcriptRange<T extends { readonly id: string }>(
  items: ReadonlyArray<T>,
  firstId: string | null,
): { start: number; end: number } {
  const found = firstId === null ? -1 : items.findIndex((item) => item.id === firstId);
  const start = found < 0 ? Math.max(0, items.length - TRANSCRIPT_WINDOW_SIZE) : found;
  return { start, end: Math.min(items.length, start + TRANSCRIPT_WINDOW_SIZE) };
}
