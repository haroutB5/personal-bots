/** The shell's grabber, title row and body padding, about 110 at the 1.3 font cap. */
const SHELL_CHROME = 110;
/** SheetShell pads its bottom edge by the safe-area inset, at least 12. */
const SHELL_BOTTOM_PAD = 12;

/**
 * The tallest a scrolling sheet body can be and still fit inside SheetShell,
 * which caps a sheet at 90% of the window. Past it the sheet clips; under it,
 * the body scrolls.
 */
export function sheetBodyMaxHeight(windowHeight: number, bottomInset: number): number {
  const cap = Math.round(windowHeight * 0.9);
  return Math.max(0, cap - SHELL_CHROME - Math.max(bottomInset, SHELL_BOTTOM_PAD));
}
