import type { JSX } from "react";

import { WifiOff } from "lucide-react";

/**
 * Cold launch with no way to reach the laptop (phone offline, tunnel down,
 * laptop asleep). Replaces the upstream crash screen, which dumps a stack
 * trace for what is, on a phone behind a tunnel, an everyday condition.
 * Rendered by the root error boundary for personal paths only.
 */
export function PersonalUnreachableScreen({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <div className="personal-app flex h-dvh flex-col items-center justify-center bg-[var(--personal-bg)] px-8 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-center">
      <div
        role="status"
        className="flex max-w-[360px] flex-col items-center gap-3 text-[var(--personal-text)]"
      >
        <WifiOff aria-hidden="true" className="size-8" strokeWidth={1.5} />
        <h1 className="text-[19px] font-bold">Laptop offline</h1>
        <p className="text-[15px] leading-[1.45] text-[var(--personal-text-secondary)]">
          Bots could not reach your laptop. Check it is on and online, and that this phone has a
          connection.
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 h-11 w-full max-w-[360px] rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-bg)]"
      >
        Try again
      </button>
    </div>
  );
}
