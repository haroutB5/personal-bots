import { OrchestrationV2ThreadBoundedSnapshot, ThreadId } from "@t3tools/contracts";
import { withOrchestrationProtocolHeader } from "@t3tools/client-runtime/state/environmentHttpAuth";
import {
  ThreadSnapshotLoader,
  type ThreadSnapshotLoadResult,
} from "@t3tools/client-runtime/state/threads";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { authorizedFetch } from "../authorizedRequest";
import type { StoredSession } from "../session";
import { noteRequestDone, noteRequestStart } from "./chatOpenPerf";

const decodeBoundedSnapshot = Schema.decodeUnknownSync(OrchestrationV2ThreadBoundedSnapshot);

/** The opt-ins the web loader sends (boundedThreadSnapshotHttp.ts): the body is about 58% smaller. */
const COMPACT_QUERY = "compactTurnItems=1&dedupeBodies=1&compactIds=1&deferWork=1";

/** A request started at the press is handed to the open that follows it within this time. */
export const PREFETCH_MAX_AGE_MS = 5_000;

interface Prefetch {
  readonly stored: StoredSession;
  readonly startedAt: number;
  readonly result: Promise<ThreadSnapshotLoadResult>;
}

const prefetched = new Map<string, Prefetch>();
let session: StoredSession | null = null;

/** The environment of the running session, for the saved-copy check at the press. */
export function snapshotSessionEnvironmentId(): string | null {
  return session?.environmentId ?? null;
}

/**
 * Starts the snapshot request of a chat the user just pressed. The open that mounts next takes
 * this request instead of sending its own. Does nothing before a session or while one is in flight.
 */
export function prefetchThreadSnapshot(threadId: string): void {
  const stored = session;
  if (stored === null) return;
  const now = performance.now();
  for (const [id, entry] of prefetched) {
    if (now - entry.startedAt > PREFETCH_MAX_AGE_MS) prefetched.delete(id);
  }
  if (prefetched.has(threadId)) return;
  const id = ThreadId.make(threadId);
  prefetched.set(threadId, {
    stored,
    startedAt: now,
    result: fetchThreadSnapshot(stored, id, now, true),
  });
}

export async function loadThreadSnapshot(
  stored: StoredSession,
  threadId: ThreadId,
): Promise<ThreadSnapshotLoadResult> {
  const early = prefetched.get(threadId);
  prefetched.delete(threadId);
  if (
    early !== undefined &&
    early.stored === stored &&
    performance.now() - early.startedAt <= PREFETCH_MAX_AGE_MS
  ) {
    const result = await early.result;
    if (result._tag === "present") return result;
  }
  return fetchThreadSnapshot(stored, threadId, performance.now(), false);
}

async function fetchThreadSnapshot(
  stored: StoredSession,
  threadId: ThreadId,
  startedAt: number,
  prefetch: boolean,
): Promise<ThreadSnapshotLoadResult> {
  noteRequestStart(threadId, startedAt, prefetch);
  try {
    const response = await authorizedFetch(
      stored,
      new URL(
        `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded?${COMPACT_QUERY}`,
        stored.httpBaseUrl,
      ),
      {
        cache: "no-store",
        headers: { ...withOrchestrationProtocolHeader({}) } as Record<string, string>,
      },
    );
    const respondedAt = performance.now();
    if (response.status === 404) return { _tag: "missing" };
    if (!response.ok) return { _tag: "unavailable" };
    const {
      turnItemsOmitLocalVisible,
      idTable: _idTable,
      ...bounded
    } = decodeBoundedSnapshot((await response.json()) as unknown);
    const projection = boundedSnapshotProjection({ ...bounded, turnItemsOmitLocalVisible });
    noteRequestDone(threadId, startedAt, {
      responseMs: respondedAt - startedAt,
      decodeMs: performance.now() - respondedAt,
    });
    return {
      _tag: "present",
      snapshot: {
        ...bounded,
        projection,
      },
      history: {
        historyCursor: bounded.historyCursor,
        hasMoreHistory: bounded.hasMoreHistory,
        latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
      },
    };
  } catch {
    return { _tag: "unavailable" };
  }
}

export const threadSnapshotLoader = (stored: StoredSession): ThreadSnapshotLoader["Service"] => {
  session = stored;
  prefetched.clear();
  return ThreadSnapshotLoader.of({
    load: (_prepared, threadId) => Effect.promise(() => loadThreadSnapshot(stored, threadId)),
  });
};
