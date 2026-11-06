/**
 * The data index of a feed row. The list renders its rows reversed, so the
 * index used by `scrollToIndex` is the mirror of the transcript position.
 */
export function scrollIndexForItem(
  rows: ReadonlyArray<{ readonly key: string }>,
  itemId: string,
): number | null {
  const index = rows.findIndex((row) => row.key === itemId);
  return index < 0 ? null : rows.length - 1 - index;
}
