/**
 * Pauses a looping avatar while it is scrolled out of sight. One shared
 * IntersectionObserver marks each watched avatar `data-offscreen` while it is
 * outside the viewport (plus a margin, so it is already moving again when it
 * scrolls in); `personal.css` pauses every animation under that attribute.
 * Where IntersectionObserver is missing nothing is marked and the avatars
 * simply keep moving.
 */
const MARGIN = "64px";

let observer: IntersectionObserver | null = null;

function sharedObserver(): IntersectionObserver | null {
  if (observer !== null) return observer;
  if (typeof IntersectionObserver === "undefined") return null;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        entry.target.toggleAttribute("data-offscreen", !entry.isIntersecting);
      }
    },
    { rootMargin: MARGIN },
  );
  return observer;
}

/** Watches `element`; the returned function stops watching and clears the mark. */
export function pauseWhileOffscreen(element: Element): () => void {
  const shared = sharedObserver();
  if (shared === null) return () => {};
  shared.observe(element);
  return () => {
    shared.unobserve(element);
    element.removeAttribute("data-offscreen");
  };
}
