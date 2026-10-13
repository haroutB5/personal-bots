import { useEffect, useState } from "react";

/**
 * How many items of a list to draw while it first mounts: `first` now, then
 * `step` more in each following frame, until all `total` are drawn. After
 * that every change shows at once.
 *
 * Why: the home's first live commit mounts about 500 nodes in one task, which
 * at 4x CPU is a 360 ms long task. Drawn in steps, no commit is more than a
 * few dozen nodes and the main thread stays free between them. The part of
 * the list that is off screen arrives two or three frames after the part that
 * is on it, so nothing a person is looking at changes.
 *
 * `enabled: false` draws everything at once (the first value is `total`).
 */
export function useStagedCount(
  total: number,
  options: { readonly enabled: boolean; readonly first: number; readonly step: number },
): number {
  const { enabled, first, step } = options;
  const [staged, setStaged] = useState<number>(() =>
    enabled && total > first ? first : Number.POSITIVE_INFINITY,
  );
  useEffect(() => {
    if (staged === Number.POSITIVE_INFINITY) return;
    if (staged >= total) {
      // Everything is drawn (or the list shrank): from here on, all at once.
      setStaged(Number.POSITIVE_INFINITY);
      return;
    }
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      setStaged(Number.POSITIVE_INFINITY);
      return;
    }
    const frame = window.requestAnimationFrame(() => setStaged((current) => current + step));
    return () => window.cancelAnimationFrame(frame);
  }, [staged, step, total]);
  return Math.min(total, staged);
}
