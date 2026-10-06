import type { JSX } from "react";

import { Pin } from "lucide-react";

/** The small pin beside a pinned chat's or group's name. */
export function PinMark(): JSX.Element {
  return (
    <Pin
      aria-hidden="true"
      data-testid="pin-mark"
      className="ml-1.5 size-3.5 shrink-0 text-[var(--personal-text-secondary)]"
      strokeWidth={2}
    />
  );
}
