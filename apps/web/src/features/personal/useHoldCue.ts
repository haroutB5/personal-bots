import { useEffect, useRef, useState } from "react";

import { type LongPressHandlers, useLongPress } from "./useLongPress";

/** How long a held target stays in its "held" pose after the hold fires (personal.css). */
export const HELD_POSE_MS = 120;

export interface HoldCueAttributes {
  readonly "data-holding": "true" | undefined;
  readonly "data-held": "true" | undefined;
}

/**
 * A long press with its visual cue: `data-holding` while the finger rests
 * (the CSS shows it after 150 ms, so a tap or a scroll never does) and
 * `data-held` for `HELD_POSE_MS` once it fires, with a short buzz where the
 * device has one (iOS Safari has none). Spread `handlers` and `attributes` on
 * the pressed element.
 */
export function useHoldCue(onHold: () => void): {
  readonly handlers: LongPressHandlers;
  readonly attributes: HoldCueAttributes;
} {
  const [hold, setHold] = useState<"holding" | "held" | null>(null);
  const heldTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (heldTimer.current !== null) window.clearTimeout(heldTimer.current);
    },
    [],
  );
  const handlers = useLongPress(
    () => {
      onHold();
      if (typeof navigator !== "undefined") navigator.vibrate?.(10);
      setHold("held");
      if (heldTimer.current !== null) window.clearTimeout(heldTimer.current);
      heldTimer.current = window.setTimeout(() => setHold(null), HELD_POSE_MS);
    },
    true,
    {
      onPressChange: (pressing) =>
        setHold((previous) => (pressing ? "holding" : previous === "holding" ? null : previous)),
    },
  );
  return {
    handlers,
    attributes: {
      "data-holding": hold === "holding" ? "true" : undefined,
      "data-held": hold === "held" ? "true" : undefined,
    },
  };
}
