/**
 * The Bots page's one-line update status, under the header: where the server
 * update is ("Update 1.66.34 ready, installs when the bots are idle", "Backing
 * up before update", "Checking update 1.66.34"), then "Updated to 1.66.34" for
 * about ten minutes - tap to dismiss - or "Update failed, still on 1.66.33".
 *
 * Nothing shows when no update is running or recently finished, and the line
 * never moves the list: its slot is reserved, empty, all the time. While the
 * server is down for its own restart the line says "Restarting for update",
 * and on /bots the generic offline banner steps aside for it
 * (`offlineBannerHiddenForRestart`): the page keeps one calm sentence.
 *
 * Polling is cheap and quiet: only while the page is visible, every 10 s while
 * something is happening, every 60 s when nothing is, and after a failed
 * request every 15 s (the restart reconnect case). All of it stops with the
 * component; the app's WebSocket already carries everything else.
 */
import type { JSX } from "react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";

import {
  fetchUpdateStatus,
  publishUpdateRestartSignal,
  readDismissedLine,
  versionFromLabel,
  visibleUpdateLine,
  writeDismissedLine,
  type DismissedLine,
  type LastSeenPhase,
  type UpdateStatusAnswer,
  type UpdateTone,
} from "./updateStatus";
import { usePersonalEnvironmentId } from "./usePersonalBots";

/** With an update moving (or the server away for its restart). */
const POLL_ACTIVE_MS = 10_000;
/** Nothing in progress: the page still asks, just quietly. */
const POLL_IDLE_MS = 60_000;
/** The last request got no answer: the server may be coming back any second. */
const POLL_RETRY_MS = 15_000;

const TONE_CLASS: Record<UpdateTone, string> = {
  plain: "text-[var(--personal-text-secondary)]",
  notice: "text-[var(--personal-review-text)]",
  problem: "text-[var(--personal-danger)]",
};

interface StatusState {
  readonly answer: UpdateStatusAnswer | null;
  /** The last request got no answer at all. */
  readonly offline: boolean;
  readonly lastSeen: LastSeenPhase | null;
  readonly dismissed: DismissedLine | null;
}

/** The line to show right now, and how to put it away. */
export function useUpdateStatusLine(versionLabel: string | null): {
  readonly line: ReturnType<typeof visibleUpdateLine>;
  readonly dismiss: () => void;
} {
  const environmentId = usePersonalEnvironmentId();
  const [state, setState] = useState<StatusState>(() => ({
    answer: null,
    offline: false,
    lastSeen: null,
    dismissed: readDismissedLine(),
  }));

  useEffect(() => {
    if (environmentId === null) return;
    let cancelled = false;
    let timer: number | null = null;
    let inFlight = false;
    const pageVisible = () =>
      typeof document === "undefined" || document.visibilityState !== "hidden";

    const schedule = (delayMs: number) => {
      if (cancelled || !pageVisible()) return;
      timer = window.setTimeout(() => {
        timer = null;
        void ask();
      }, delayMs);
    };

    const ask = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      const next = await fetchUpdateStatus();
      inFlight = false;
      if (cancelled) return;
      if (next === null) {
        setState((prev) => (prev.offline ? prev : { ...prev, offline: true }));
        schedule(POLL_RETRY_MS);
        return;
      }
      const atMs = Date.now();
      setState((prev) => ({
        answer: next,
        offline: false,
        // A phase the page has seen stays known through an outage: that is
        // what turns the offline state into "Restarting for update".
        lastSeen:
          next.phase === null ? prev.lastSeen : { phase: next.phase, version: next.version, atMs },
        dismissed: prev.dismissed,
      }));
      schedule(next.phase === null ? POLL_IDLE_MS : POLL_ACTIVE_MS);
    };

    // Back on screen (the phone was asleep through the restart): ask at once
    // rather than waiting out the idle interval. Off screen: stop asking.
    const onVisibility = () => {
      if (cancelled) return;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (pageVisible()) void ask();
    };

    document.addEventListener("visibilitychange", onVisibility);
    if (pageVisible()) void ask();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [environmentId]);

  const line = visibleUpdateLine({
    answer: state.answer,
    offline: state.offline,
    lastSeen: state.lastSeen,
    dismissed: state.dismissed,
    fallbackVersion: versionFromLabel(versionLabel),
    nowMs: Date.now(),
  });
  // The offline banner watches this: on /bots it steps aside while the line
  // is the calm "Restarting for update" (offline after a restart-expected
  // phase), and comes back if that drags on past its grace.
  const restartingLine =
    line !== null && (line.phase === "activating" || line.phase === "restarting");
  useEffect(() => {
    publishUpdateRestartSignal(state.lastSeen, restartingLine);
  }, [state.lastSeen, restartingLine]);
  const dismiss = () => {
    if (line === null || !line.dismissible) return;
    const record: DismissedLine = { phase: line.phase, version: line.version, atMs: Date.now() };
    writeDismissedLine(record);
    setState((prev) => ({ ...prev, dismissed: record }));
  };

  return { line, dismiss };
}

/**
 * The line under the header. Its slot is always there and always one line
 * tall, so the list never jumps when the words appear or go; empty is the
 * normal state.
 *
 * `versionLabel` is the version the page already shows next to "Bots" (the
 * server's own stamp): the fallback for "still on 1.66.33" when the endpoint
 * could not name the previous version itself.
 */
export function UpdateStatusLine({
  versionLabel = null,
}: {
  readonly versionLabel?: string | null;
} = {}): JSX.Element {
  const { line, dismiss } = useUpdateStatusLine(versionLabel);
  return (
    <div className="mt-1 h-4 min-w-0" aria-live="polite">
      {line === null ? null : line.dismissible ? (
        <button
          type="button"
          onClick={dismiss}
          aria-label={`${line.text}, tap to dismiss`}
          className={cn(
            "block h-4 w-full truncate text-left text-[12px] leading-4 font-medium",
            TONE_CLASS[line.tone],
          )}
        >
          {line.text}
        </button>
      ) : (
        <p className={cn("h-4 truncate text-[12px] leading-4 font-medium", TONE_CLASS[line.tone])}>
          {line.text}
        </p>
      )}
    </div>
  );
}
