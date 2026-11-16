/** `rows.toReversed()` once per rows array: the same rows give the same reversed array. */
export function createRowReverser<T>(): (rows: ReadonlyArray<T>) => ReadonlyArray<T> {
  let lastRows: ReadonlyArray<T> | null = null;
  let lastReversed: ReadonlyArray<T> = [];
  return (rows) => {
    if (rows !== lastRows) {
      lastReversed = rows.toReversed();
      lastRows = rows;
    }
    return lastReversed;
  };
}
