/**
 * The Instructions box on the edit-bot form. A bot's instructions run to pages,
 * so the box opens showing only its first lines and the rest of the form stays
 * within reach. The text itself never leaves the field: collapsing only clips
 * what is drawn.
 */
export const INSTRUCTIONS_COLLAPSED_LINES = 6;

export interface InstructionsFieldView {
  /** Height the box is clipped to, or null when it shows all of its text. */
  readonly clipHeight: number | null;
  /** Soft fade over the last visible line, shown only while text is hidden. */
  readonly fade: boolean;
  /** The control under the box, or null when there is nothing to show or hide. */
  readonly control: "Show all" | "Show less" | null;
}

/** Height of the collapsed box: the first lines plus the box's own padding. */
export function instructionsCollapsedHeight(lineHeight: number, verticalPadding: number): number {
  return Math.ceil(INSTRUCTIONS_COLLAPSED_LINES * lineHeight + verticalPadding);
}

export function instructionsFieldView(input: {
  readonly expanded: boolean;
  /** Measured height of all the text with its padding; null before the first measure. */
  readonly contentHeight: number | null;
  readonly collapsedHeight: number;
}): InstructionsFieldView {
  // A pixel of slack keeps a box that exactly fits from offering "Show all".
  const overflows = input.contentHeight !== null && input.contentHeight > input.collapsedHeight + 1;
  if (input.expanded) {
    return { clipHeight: null, fade: false, control: overflows ? "Show less" : null };
  }
  return {
    clipHeight: input.collapsedHeight,
    fade: overflows,
    control: overflows ? "Show all" : null,
  };
}

export type InstructionsFieldEvent = "focus" | "toggle";

/** Focus always opens the box. The control flips it. Neither touches the text. */
export function instructionsExpandedAfter(
  expanded: boolean,
  event: InstructionsFieldEvent,
): boolean {
  return event === "focus" ? true : !expanded;
}
