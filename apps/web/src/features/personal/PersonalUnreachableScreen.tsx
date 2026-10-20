import type { JSX } from "react";
import { useEffect, useRef } from "react";

import { WifiOff } from "lucide-react";

import { offlineBannerHint } from "./offlineBanner";
import { useOutboxCount } from "./outbox";

/**
 * Cold launch with no way to reach the laptop (phone offline, tunnel down,
 * laptop asleep). Replaces the upstream crash screen, which dumps a stack
 * trace for what is, on a phone behind a tunnel, an everyday condition.
 * Rendered by the root error boundary for personal paths only.
 */
export function PersonalUnreachableScreen({
  onRetry,
}: {
  onRetry: () => void | Promise<void>;
}): JSX.Element {
  const retry = useRef(onRetry);
  useEffect(() => {
    retry.current = onRetry;
  }, [onRetry]);
  useEffect(() => {
    try {
      if (localStorage.getItem("bots:origin-recovery") === "off") return;
    } catch {
      /* Storage may be unavailable. */
    }
    let delay = 2_000;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let inFlight = false;
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(attempt, delay);
      delay = Math.min(delay * 2, 30_000);
    };
    const attempt = async () => {
      clearTimeout(timer);
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        if (document.visibilityState !== "hidden" && navigator.onLine !== false)
          await retry.current();
      } catch {
        // The route error boundary retains failures; continue recovery later.
      } finally {
        inFlight = false;
        schedule();
      }
    };
    const visible = () => {
      if (document.visibilityState === "visible") attempt();
    };
    schedule();
    window.addEventListener("online", attempt);
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("online", attempt);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  // Messages typed while the laptop was away are still on this device (outbox.ts):
  // say so, because the app closing and opening again must not look like losing them.
  const waiting = useOutboxCount();
  return (
    <div className="personal-app flex h-dvh flex-col items-center justify-center bg-[var(--personal-bg)] px-8 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-center">
      <div
        role="status"
        className="flex max-w-[360px] flex-col items-center gap-3 text-[var(--personal-text)]"
      >
        <WifiOff aria-hidden="true" className="size-8" strokeWidth={1.5} />
        <h1 className="text-[19px] font-bold">Reconnecting to your laptop</h1>
        <p className="text-[15px] leading-[1.45] text-[var(--personal-text-secondary)]">
          Bots is waiting for your laptop to respond. We’ll keep trying automatically.
        </p>
        {waiting > 0 ? (
          <p className="text-[15px] leading-[1.45] font-medium">{offlineBannerHint(waiting)}</p>
        ) : null}
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
