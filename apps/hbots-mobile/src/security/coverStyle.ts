/**
 * How the app underneath is treated while the lock hides it. It stays mounted, so
 * the open screen, the scroll position and any draft come back after the unlock,
 * but it takes no space and no part of it is drawn or exposed. A plain opaque cover
 * would leave every view on screen for accessibility services and UI dumps to read.
 */
export function underLock(covered: boolean) {
  return {
    display: covered ? ("none" as const) : ("flex" as const),
    importantForAccessibility: covered ? ("no-hide-descendants" as const) : ("auto" as const),
    accessibilityElementsHidden: covered,
  };
}
