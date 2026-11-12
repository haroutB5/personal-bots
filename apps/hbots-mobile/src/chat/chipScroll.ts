export const CHIP_SCROLL_MARGIN = 16;

export interface ChipScrollInput {
  readonly chipX: number;
  readonly chipWidth: number;
  readonly currentX: number;
  readonly viewportWidth: number;
  readonly contentWidth: number;
  readonly margin?: number;
}

/** The scroll x that brings a chip fully into view with a margin on each side. */
export function chipScrollX({
  chipX,
  chipWidth,
  currentX,
  viewportWidth,
  contentWidth,
  margin = CHIP_SCROLL_MARGIN,
}: ChipScrollInput): number {
  const maxX = Math.max(0, contentWidth - viewportWidth);
  const chipEnd = chipX + chipWidth;
  const viewportEnd = currentX + viewportWidth;
  let next = currentX;
  if (chipX < currentX + margin) next = chipX - margin;
  else if (chipEnd > viewportEnd - margin) next = chipEnd + margin - viewportWidth;
  return Math.min(Math.max(next, 0), maxX);
}
