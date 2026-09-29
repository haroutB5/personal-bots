/**
 * Select mode for any list (chats, files, memory): which rows are picked,
 * what the header says, and the one line a bulk action reports. The row ids
 * are plain strings, so every list shares the same rules.
 */

/** What a list's rows are called, for counts: `{ one: "file", many: "files" }`. */
export interface BulkNoun {
  readonly one: string;
  readonly many: string;
}

/** "1 file", "12 files". */
export function countOf(count: number, noun: BulkNoun): string {
  return count === 1 ? `1 ${noun.one}` : `${count} ${noun.many}`;
}

/** Adds the row if it is not selected, removes it if it is. */
export function toggleSelection(selected: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * The selection limited to rows still on screen, in list order: a row
 * deleted elsewhere, moved away or hidden by a search stops counting, so
 * "N selected" and the action only ever cover rows the user can see.
 */
export function visibleSelection(
  selected: ReadonlySet<string>,
  shownIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return shownIds.filter((id) => selected.has(id));
}

/** Every row shown is selected (and there is at least one). */
export function allSelected(
  selected: ReadonlySet<string>,
  shownIds: ReadonlyArray<string>,
): boolean {
  return shownIds.length > 0 && shownIds.every((id) => selected.has(id));
}

/** Select all, or Deselect all when every row shown is already selected. */
export function toggleAllSelection(
  selected: ReadonlySet<string>,
  shownIds: ReadonlyArray<string>,
): ReadonlySet<string> {
  const next = new Set(selected);
  if (allSelected(selected, shownIds)) for (const id of shownIds) next.delete(id);
  else for (const id of shownIds) next.add(id);
  return next;
}

/** The select-mode header: "Select files" before anything is picked, then "3 selected". */
export function selectedCountLabel(count: number, noun: BulkNoun): string {
  return count === 0 ? `Select ${noun.many}` : `${count} selected`;
}

/** The destructive confirm's button: "Delete 12 files". */
export function bulkDeleteConfirmLabel(count: number, noun: BulkNoun): string {
  return `Delete ${countOf(count, noun)}`;
}

/** Past and passive forms of a bulk action: `{ done: "Deleted", failed: "deleted" }`. */
export interface BulkVerb {
  readonly done: string;
  readonly failed: string;
}

export const DELETE_VERB: BulkVerb = { done: "Deleted", failed: "deleted" };

/**
 * What a batch did, in one line: "Deleted 12 files." or, when some were
 * refused, "Deleted 10 files. 2 files couldn't be deleted: <first reason>."
 */
export function bulkResultNotice(
  verb: BulkVerb,
  noun: BulkNoun,
  doneCount: number,
  failureMessages: ReadonlyArray<string>,
): { readonly text: string; readonly failed: boolean } {
  const failed = failureMessages.length;
  const parts: Array<string> = [];
  if (doneCount > 0 || failed === 0) parts.push(`${verb.done} ${countOf(doneCount, noun)}.`);
  if (failed > 0) {
    const reason = failureMessages[0]?.trim().replace(/[.\s]+$/, "") ?? "";
    parts.push(
      `${countOf(failed, noun)} couldn't be ${verb.failed}${reason === "" ? "." : `: ${reason}.`}`,
    );
  }
  return { text: parts.join(" "), failed: failed > 0 };
}

/** Splits a selection into requests the server accepts (it takes at most `size` ids each). */
export function chunkIds<T>(ids: ReadonlyArray<T>, size: number): ReadonlyArray<ReadonlyArray<T>> {
  const chunks: Array<ReadonlyArray<T>> = [];
  for (let start = 0; start < ids.length; start += size) {
    chunks.push(ids.slice(start, start + size));
  }
  return chunks;
}
