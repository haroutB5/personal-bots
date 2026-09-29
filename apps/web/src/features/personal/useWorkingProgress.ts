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

const NO_NOTES: ReadonlyMap<string, string> = new Map();

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
): ReadonlyMap<string, string> {
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
    return new Map(query.data.notes.map((entry) => [entry.threadId as string, entry.note]));
  }, [atom, query.data]);
}
