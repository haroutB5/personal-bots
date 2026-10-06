/**
 * Selecting a few sentences of a message on a touch screen (1.65.1).
 *
 * A message's text is not selectable on touch (the long press opens the Reply
 * menu instead). "Select text" in that menu, or a double tap on the text, turns
 * the one message selectable and selects it by script, so iOS shows its own
 * handles and Copy bubble for the owner to drag. The DOM work is here, with the
 * pure rules (what counts as a double tap, where a word ends) on their own so
 * they are tested without a browser.
 */

/** Two taps this close in time are a double tap (iOS uses about 300 ms). */
export const DOUBLE_TAP_MS = 320;
/** ...and this close in space. */
export const DOUBLE_TAP_SLOP_PX = 24;
/** A tap shorter than this, that did not move, can be the first of a double tap. */
export const TAP_MAX_MS = 250;

export interface TapPoint {
  readonly t: number;
  readonly x: number;
  readonly y: number;
}

/** Whether `next` (a finger going down) completes a double tap that began at `previous`. */
export function isDoubleTap(previous: TapPoint | null, next: TapPoint): boolean {
  if (previous === null) return false;
  const elapsed = next.t - previous.t;
  if (elapsed < 0 || elapsed > DOUBLE_TAP_MS) return false;
  return (
    Math.abs(next.x - previous.x) <= DOUBLE_TAP_SLOP_PX &&
    Math.abs(next.y - previous.y) <= DOUBLE_TAP_SLOP_PX
  );
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const WORD_JOINER = /['’\-.]/u;

const isWordCharAt = (text: string, index: number): boolean =>
  index >= 0 && index < text.length && WORD_CHAR.test(text.charAt(index));

/** A joiner (don't, well-known, 3.5) only joins when a word character sits on both sides. */
const isJoinerAt = (text: string, index: number): boolean =>
  index >= 0 &&
  index < text.length &&
  WORD_JOINER.test(text.charAt(index)) &&
  isWordCharAt(text, index - 1) &&
  isWordCharAt(text, index + 1);

/**
 * The word under a caret at `offset` in `text` (the caret sits between two
 * characters, so the word is the one on either side of it), or null on
 * whitespace and punctuation with no word beside it.
 */
export function wordBoundsAt(
  text: string,
  offset: number,
): { readonly start: number; readonly end: number } | null {
  const at = Math.max(0, Math.min(text.length, offset));
  const inWord = (index: number) => isWordCharAt(text, index) || isJoinerAt(text, index);
  let anchor = -1;
  if (inWord(at)) anchor = at;
  else if (inWord(at - 1)) anchor = at - 1;
  if (anchor < 0) return null;
  let start = anchor;
  while (inWord(start - 1)) start -= 1;
  let end = anchor + 1;
  while (inWord(end)) end += 1;
  return { start, end };
}

/** What a tap on one of these does by itself; a double tap on it is not a selection. */
export const INTERACTIVE_SELECTOR =
  'a[href], button, summary, input, textarea, select, [role="button"], [role="link"], [role="menuitem"]';

/** The slice of `Document` the helpers use, so a test can hand in a fake. */
export interface SelectionDocument {
  readonly getSelection: () => Selection | null;
  readonly createRange: () => Range;
  readonly caretPositionFromPoint?:
    | ((x: number, y: number) => { offsetNode: Node; offset: number } | null)
    | undefined;
  readonly caretRangeFromPoint?: ((x: number, y: number) => Range | null) | undefined;
}

const TEXT_NODE = 3;

/** Selects the word under (x, y) inside `root`. False when there is no word there. */
export function selectWordAtPoint(
  root: Node,
  x: number,
  y: number,
  doc: SelectionDocument = document,
): boolean {
  let node: Node | null = null;
  let offset = 0;
  const position = doc.caretPositionFromPoint?.(x, y) ?? null;
  if (position !== null) {
    node = position.offsetNode;
    offset = position.offset;
  } else {
    const range = doc.caretRangeFromPoint?.(x, y) ?? null;
    if (range !== null) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (node === null || node.nodeType !== TEXT_NODE || !root.contains(node)) return false;
  const bounds = wordBoundsAt(node.textContent ?? "", offset);
  if (bounds === null) return false;
  const selection = doc.getSelection();
  if (selection === null) return false;
  const range = doc.createRange();
  range.setStart(node, bounds.start);
  range.setEnd(node, bounds.end);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** Selects everything inside `root`. False when the browser has no selection to give. */
export function selectAllIn(root: Node, doc: SelectionDocument = document): boolean {
  const selection = doc.getSelection();
  if (selection === null) return false;
  const range = doc.createRange();
  range.selectNodeContents(root);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** Whether the selection holds some text that lies inside `root`. */
export function hasSelectionIn(root: Node, doc: SelectionDocument = document): boolean {
  const selection = doc.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return false;
  return root.contains(selection.anchorNode) || root.contains(selection.focusNode);
}

/** Drops the selection if it lies inside `root`; a selection elsewhere is left alone. */
export function clearSelectionIn(root: Node, doc: SelectionDocument = document): void {
  const selection = doc.getSelection();
  if (selection === null || selection.rangeCount === 0) return;
  if (root.contains(selection.anchorNode) || root.contains(selection.focusNode)) {
    selection.removeAllRanges();
  }
}
