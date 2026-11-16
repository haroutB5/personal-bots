import { OrchestrationV2ThreadBoundedSnapshot, type ThreadId } from "@t3tools/contracts";
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

export async function loadThreadSnapshot(
  stored: StoredSession,
  threadId: ThreadId,
): Promise<ThreadSnapshotLoadResult> {
  const startedAt = performance.now();
  noteRequestStart(threadId, startedAt);
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

export const threadSnapshotLoader = (stored: StoredSession): ThreadSnapshotLoader["Service"] =>
  ThreadSnapshotLoader.of({
    load: (_prepared, threadId) => Effect.promise(() => loadThreadSnapshot(stored, threadId)),
  });
