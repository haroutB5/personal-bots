/**
 * Makes everything outside an open overlay inert, and undoes it on close.
 *
 * The full-screen computer panel is a `role="dialog"` with `aria-modal`, but
 * `aria-modal` is only a promise to assistive technology: without this the page
 * behind the overlay still takes Tab, still takes clicks and is still read out.
 * The overlay is rendered in place rather than in a portal, so the background
 * is every sibling along its ancestor chain up to the document.
 *
 * `inert` is what does the trapping: with the rest of the page inert there is
 * nothing outside the dialog left to focus.
 */
export function inertOutside(overlay: Element | null): () => void {
  const inerted: HTMLElement[] = [];
  let node: Element | null = overlay;
  while (node?.parentElement != null) {
    const parent: HTMLElement = node.parentElement;
    for (const sibling of Array.from(parent.children)) {
      // Already inert for another reason: leave it, and leave it alone on undo.
      if (sibling === node || (sibling as HTMLElement).inert === true) continue;
      (sibling as HTMLElement).inert = true;
      inerted.push(sibling as HTMLElement);
    }
    node = parent;
  }
  return () => {
    for (const element of inerted) element.inert = false;
  };
}
