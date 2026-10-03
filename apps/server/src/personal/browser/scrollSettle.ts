/**
 * Waiting for a phone's scroll to land before the tap that follows it.
 *
 * A wheel's `Input.dispatchMouseEvent` returns once Chrome has taken the event,
 * not once the page has applied it: the new scroll offset reaches the page at
 * the next frame, and on a busy page that frame can be tens of milliseconds
 * away. A tap dispatched straight after the last wheel then hit-tests the page
 * still showing the old offset and misses the button the finger was aimed at.
 * Before 1.60.34 the line of waiting inputs happened to hide it: scroll steps
 * were small and ran one at a time with a move between them, so the page was
 * rarely more than a step behind. Merged steps put a bigger last step right in
 * front of the tap.
 *
 * So a pointer input that follows a wheel within `SCROLL_SETTLE_WINDOW_MS`
 * first waits, inside the page, until the scroll offsets (the window's and
 * those of every scrollable ancestor of the pointer's point) have stayed the
 * same for a few frames, at most `SCROLL_SETTLE_CAP_MS`. The script reads
 * numbers only and returns how long it waited; nothing from the page leaves it.
 *
 * Kill switch: `T3CODE_PERSONAL_BROWSER_SCROLL_SETTLE=off` (server environment)
 * dispatches the tap at once, as in 1.60.34.
 */

/** A pointer input within this long of a wheel waits for the scroll to settle. */
export const SCROLL_SETTLE_WINDOW_MS = 800;
/** The longest the page is waited for. One slow frame can overshoot it. */
export const SCROLL_SETTLE_CAP_MS = 200;
/** Frames in a row the scroll offsets must stay unchanged. */
export const SCROLL_SETTLE_STABLE_FRAMES = 3;
/** The page did not answer within the cap (a hidden tab draws no frames). */
export const SCROLL_SETTLE_NO_ANSWER = -1;

/** The expression that waits in the page; it resolves to the milliseconds waited, or -1. */
export const scrollSettleExpression = (x: number, y: number): string => {
  const px = Math.round(Number.isFinite(x) ? x : 0);
  const py = Math.round(Number.isFinite(y) ? y : 0);
  return `((x, y, capMs, stableFrames) => new Promise((resolve) => {
    const started = performance.now();
    const signature = () => {
      let text = scrollX + "," + scrollY;
      let element = document.elementFromPoint(x, y);
      for (let depth = 0; element && depth < 50; depth++) {
        text += "," + element.scrollTop + "," + element.scrollLeft;
        element = element.parentElement;
      }
      return text;
    };
    let last = signature();
    let stable = 0;
    const step = () => {
      const now = signature();
      stable = now === last ? stable + 1 : 0;
      last = now;
      if (stable >= stableFrames || performance.now() - started >= capMs) {
        resolve(Math.round(performance.now() - started));
      } else {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
    setTimeout(() => resolve(${SCROLL_SETTLE_NO_ANSWER}), capMs + 50);
  }))(${px}, ${py}, ${SCROLL_SETTLE_CAP_MS}, ${SCROLL_SETTLE_STABLE_FRAMES})`;
};

/** What `waitForScroll` reports: how long the wait was and whether the page ran out the cap. */
export const settleOutcome = (
  result: unknown,
  elapsedMs: number,
): { readonly waitedMs: number; readonly capped: boolean } => {
  const waited = typeof result === "number" && result >= 0 ? result : elapsedMs;
  return {
    waitedMs: waited,
    capped: result === SCROLL_SETTLE_NO_ANSWER || waited >= SCROLL_SETTLE_CAP_MS,
  };
};
