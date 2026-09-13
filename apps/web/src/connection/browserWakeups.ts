import type { Wakeups } from "@t3tools/client-runtime/connection";

/** Match the native mobile client's policy for sockets suspended by the OS. */
export const BACKGROUND_RECONNECT_AFTER_MS = 10_000;

export function subscribeBrowserWakeups(
  emit: (reason: Wakeups.ConnectionWakeup) => void,
  mobile: boolean,
  page: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document,
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  let hiddenAt = page.visibilityState === "hidden" ? Date.now() : null;
  const resume = () => {
    if (page.visibilityState !== "visible") return;
    const elapsed = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    emit(
      !mobile
        ? "application-active"
        : elapsed >= BACKGROUND_RECONNECT_AFTER_MS
          ? "application-active-reconnect"
          : "application-active-probe",
    );
  };
  const visibility = () => {
    if (page.visibilityState === "hidden") hiddenAt ??= Date.now();
    else resume();
  };
  const hide = () => {
    hiddenAt ??= Date.now();
  };
  const show = (event: PageTransitionEvent) => {
    // BFCache restores are not guaranteed to emit visibilitychange.
    if (event.persisted && hiddenAt !== null) resume();
  };
  page.addEventListener("visibilitychange", visibility);
  target.addEventListener("pagehide", hide);
  target.addEventListener("pageshow", show);
  return () => {
    page.removeEventListener("visibilitychange", visibility);
    target.removeEventListener("pagehide", hide);
    target.removeEventListener("pageshow", show);
  };
}
