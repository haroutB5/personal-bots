import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useMemo, useRef } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";

/**
 * The latest progress note of each working chat, for the Bots list rows. The
 * server reads them from the projection (thinking summaries and tool step
 * titles of the running turn); the list itself only holds thread shells.
 */
export const personalBotsWorkingProgress = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "personal-bots:working-progress",
    tag: WS_METHODS.personalBotsWorkingProgress,
    staleTimeMs: 0,
    idleTtlMs: 60_000,
  },
);

/** At most one read this often while a working chat keeps changing. */
export const PROGRESS_REFRESH_MS = 2_500;

/** A note and the turn the server read it from. */
export interface WorkingProgressEntry {
  readonly note: string;
  readonly turnId: string | null;
  /** The turn has started a tool step (the server's `toolStep`). */
  readonly toolStep?: boolean | undefined;
}

const NO_NOTES: ReadonlyMap<string, WorkingProgressEntry> = new Map();

/**
 * The note to show for a working chat, or undefined. Only a note read from the
 * turn the chat's shell reports as its latest. The read is cached for a minute
 * after its last row leaves (`idleTtlMs`), so when the same chat starts its
 * next turn the previous turn's last note is still what the query holds until
 * the new read lands: that stale line flashed on the row for about a second.
 * A note from another turn is not this turn's, whatever its text.
 */
export function currentProgressNote(
  entry: WorkingProgressEntry | undefined,
  shell: { readonly latestTurn?: { readonly turnId: string } | null },
): string | undefined {
  if (entry === undefined) return undefined;
  return entry.turnId === (shell.latestTurn?.turnId ?? null) ? entry.note : undefined;
}

/**
 * The chat's current turn has started a tool step, so it is working, not
 * thinking, even before its first line of text. The list's shells only know
 * the reply text (`isTurnThinking`), so without this a turn that went straight
 * to tools kept the thinking pose, and no comet, until it said something.
 * Same turn check as {@link currentProgressNote}.
 */
export function currentTurnHasToolStep(
  entry: WorkingProgressEntry | undefined,
  shell: { readonly latestTurn?: { readonly turnId: string } | null },
): boolean {
  if (entry === undefined || entry.toolStep !== true) return false;
  return entry.turnId === (shell.latestTurn?.turnId ?? null);
}

/** How long to hold a read that is due, so reads stay at least {@link PROGRESS_REFRESH_MS} apart. */
export function progressRefreshDelayMs(lastRefreshMs: number, nowMs: number): number {
  return Math.max(0, lastRefreshMs + PROGRESS_REFRESH_MS - nowMs);
}

export interface WorkingProgressTarget {
  readonly threadId: string;
  /** The shell's `updatedAt`: moves whenever the working chat writes anything. */
  readonly updatedAt: string;
}

/**
 * Notes by thread id for the chats that are working right now. Nothing is
 * asked while no bot works. While one does, the read repeats when its chat
 * moves (its shell's `updatedAt`), at most every {@link PROGRESS_REFRESH_MS},
 * and never while the page is hidden. A chat that stops working drops out of
 * the request, so its note goes with its turn.
 */
export function useWorkingProgressNotes(
  environmentId: EnvironmentId | null,
  targets: ReadonlyArray<WorkingProgressTarget>,
): ReadonlyMap<string, WorkingProgressEntry> {
  const idsKey = targets
    .map((target) => target.threadId)
    .toSorted()
    .join(",");
  const tick = targets
    .map((target) => `${target.threadId}@${target.updatedAt}`)
    .toSorted()
    .join("|");
  const atom = useMemo(
    () =>
      environmentId === null || idsKey === ""
        ? null
        : personalBotsWorkingProgress({
            environmentId,
            input: { threadIds: idsKey.split(",") as ThreadId[] },
          }),
    [environmentId, idsKey],
  );
  const query = useEnvironmentQuery(atom);
  const refreshRef = useRef(query.refresh);
  refreshRef.current = query.refresh;
  const lastRefreshRef = useRef(0);

  useEffect(() => {
    if (atom === null) return;
    const wait = progressRefreshDelayMs(lastRefreshRef.current, Date.now());
    const timer = window.setTimeout(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      lastRefreshRef.current = Date.now();
      refreshRef.current();
    }, wait);
    return () => window.clearTimeout(timer);
  }, [atom, tick]);

  return useMemo(() => {
    if (atom === null || query.data === null) return NO_NOTES;
    return new Map(
      query.data.notes.map((entry) => [
        entry.threadId as string,
        { note: entry.note, turnId: entry.turnId, toolStep: entry.toolStep },
      ]),
    );
  }, [atom, query.data]);
}
