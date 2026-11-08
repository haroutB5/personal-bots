import type { ThreadId } from "@t3tools/contracts";
import { OrchestrationV2ThreadDetailSnapshot } from "@t3tools/contracts";
import { withOrchestrationProtocolHeader } from "@t3tools/client-runtime/state/environmentHttpAuth";
import {
  ThreadSnapshotLoader,
  type ThreadSnapshotLoadResult,
} from "@t3tools/client-runtime/state/threads";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { authorizedFetch } from "../authorizedRequest";
import type { StoredSession } from "../session";

const decodeThreadSnapshot = Schema.decodeUnknownSync(OrchestrationV2ThreadDetailSnapshot);

export async function loadThreadSnapshot(
  stored: StoredSession,
  threadId: ThreadId,
): Promise<ThreadSnapshotLoadResult> {
  try {
    const response = await authorizedFetch(
      stored,
      new URL(
        `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`,
        stored.httpBaseUrl,
      ),
      {
        cache: "no-store",
        headers: { ...withOrchestrationProtocolHeader({}) } as Record<string, string>,
      },
    );
    if (response.status === 404) return { _tag: "missing" };
    if (!response.ok) return { _tag: "unavailable" };
    const snapshot = decodeThreadSnapshot((await response.json()) as unknown);
    return {
      _tag: "present",
      snapshot,
      history: {
        historyCursor: snapshot.historyCursor ?? null,
        hasMoreHistory: snapshot.hasMoreHistory ?? false,
        latestLocalTurnOrdinal: snapshot.latestLocalTurnOrdinal ?? null,
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
