/**
 * The Bots page's one-line update status, under the header: where the server
 * update is ("Update 1.66.34 ready, installs when the bots are idle", "Backing
 * up before update", "Checking update 1.66.34"), then "Updated to 1.66.34" for
 * ten seconds - tap to dismiss - or "Update failed, still on 1.66.33".
 *
 * The row takes no space at all when there is nothing to say: the list sits
 * right under the header, nothing is reserved for words that may never come.
 * A line that arrives expands the row smoothly, and one that goes fades and
 * collapses the same way (opacity plus a grid-rows collapse, reduced motion
 * honoured), the last words staying in the DOM through the collapse. While
 * the server is down for its own restart the line says "Restarting for
 * update", and on /bots the generic offline banner steps aside for it
 * (`offlineBannerHiddenForRestart`): the page keeps one calm sentence.
 *
 * The finished "Updated to x" line is a one-time note, once per version per
 * device: it stands for ten seconds after it is first shown, then collapses
 * away, and the version is remembered so the line never sits there repeating
 * the version the header already carries. The moving phases and the failure
 * phases come back every time they are true (see updateStatus.ts).
 *
 * Polling is cheap and quiet: only while the page is visible, every 10 s while
 * something is happening, every 60 s when nothing is, and after a failed
 * request every 15 s (the restart reconnecting case). All of it stops with the
 * component; the app's WebSocket already carries everything else.
 */
import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";

import { cn } from "~/lib/utils";

import {
  fetchUpdateStatus,
  publishUpdateRestartSignal,
  readDismissedLine,
  readSeenUpdated,
  UPDATED_LINE_MS,
  UPDATED_PHASES,
  versionFromLabel,
  visibleUpdateLine,
  writeDismissedLine,
  writeSeenUpdated,
  type DismissedLine,
  type LastSeenPhase,
  type SeenUpdated,
  type UpdateLine,
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
/** How long the words take to fade and the row to collapse; the row's own
 * transition is the longer half, so the words leave with it. */
export const LINE_COLLAPSE_MS = 200;

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
  /** The "Updated to x" line this device has already shown, if any. */
  readonly seenUpdated: SeenUpdated | null;
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
    seenUpdated: readSeenUpdated(),
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
        seenUpdated: prev.seenUpdated,
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
    seenUpdated: state.seenUpdated,
    fallbackVersion: versionFromLabel(versionLabel),
    nowMs: Date.now(),
  });
  // "Updated to x" is a ten-second note, once per version per device: the
  // version is remembered the moment the words appear (closing the app inside
  // the ten seconds does not bring them back), and the row collapses when the
  // time is up.
  const updatedLine = line !== null && UPDATED_PHASES.has(line.phase) ? line : null;
  const updatedKey =
    updatedLine === null ? null : `${updatedLine.phase}|${updatedLine.version ?? ""}`;
  const updatedVersion = updatedLine?.version ?? null;
  const rememberSeen = useCallback((version: string | null) => {
    const record: SeenUpdated = { version, atMs: Date.now() };
    writeSeenUpdated(record);
    setState((prev) => ({ ...prev, seenUpdated: record }));
  }, []);
  useEffect(() => {
    if (updatedKey === null) return;
    writeSeenUpdated({ version: updatedVersion, atMs: Date.now() });
    const timer = window.setTimeout(() => rememberSeen(updatedVersion), UPDATED_LINE_MS);
    return () => window.clearTimeout(timer);
  }, [updatedKey, updatedVersion, rememberSeen]);
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
    if (UPDATED_PHASES.has(line.phase)) {
      // The one-time note, put away early: remembered exactly as if its ten
      // seconds had run out.
      rememberSeen(line.version);
      return;
    }
    const record: DismissedLine = { phase: line.phase, version: line.version, atMs: Date.now() };
    writeDismissedLine(record);
    setState((prev) => ({ ...prev, dismissed: record }));
  };

  return { line, dismiss };
}

/** Two lines render the same words the same way. */
const sameLine = (a: UpdateLine, b: UpdateLine): boolean =>
  a.text === b.text &&
  a.tone === b.tone &&
  a.dismissible === b.dismissible &&
  a.phase === b.phase &&
  a.version === b.version;

/**
 * The line under the header. It takes no space at all when there is nothing
 * to say - the normal state - and expands smoothly when words arrive; when
 * they go, the row fades and collapses and the words leave the DOM with it.
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
  // The last line stays in the DOM through its collapse, so the words fade
  // with the row instead of vanishing a frame before it.
  const [lastLine, setLastLine] = useState<UpdateLine | null>(line);
  useEffect(() => {
    if (line !== null) {
      setLastLine((prev) => (prev !== null && sameLine(prev, line) ? prev : line));
      return;
    }
    if (lastLine === null) return;
    const timer = window.setTimeout(() => setLastLine(null), LINE_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [line, lastLine]);
  const text = line ?? lastLine;
  const open = line !== null;
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
    >
      <div
        inert={!open}
        className={cn(
          "min-h-0 overflow-hidden transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none motion-reduce:transform-none",
          open ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0 duration-100",
        )}
      >
        <div className="mt-1 h-4 min-w-0" aria-live="polite">
          {text === null ? null : text.dismissible ? (
            <button
              type="button"
              onClick={dismiss}
              aria-label={`${text.text}, tap to dismiss`}
              className={cn(
                "block h-4 w-full truncate text-left text-[12px] leading-4 font-medium",
                TONE_CLASS[text.tone],
              )}
            >
              {text.text}
            </button>
          ) : (
            <p
              className={cn(
                "h-4 truncate text-[12px] leading-4 font-medium",
                TONE_CLASS[text.tone],
              )}
            >
              {text.text}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
