// Where a turn came from: who wrote the message that started it and whether the bot read the web in it. The
// facts the rule and note guards judge a save by.
import * as Effect from "effect/Effect";

import type { ThreadId } from "@t3tools/contracts";

import type { MemoryCore } from "./memoryCore.ts";
import {
  isOwnerMessageId,
  originOfMessage,
  usedWebTool,
  WEB_TOOL_NEEDLES,
} from "./memoryProvenancePolicy.ts";
import type { PersonalMemoryService } from "./PersonalMemoryService.ts";

export const makeMemoryProvenance = (core: MemoryCore) => {
  const { sql, engine, rel } = core;

  const ownerMessages: PersonalMemoryService["Service"]["ownerMessages"] = (threadId) =>
    Effect.gen(function* () {
      // App-written user-role messages all carry a "personal-" id (task and
      // steer briefs, routine runs, group relays, notices, lead answers).
      const recent = yield* sql<{ readonly text: string; readonly messageId: string }>`
        SELECT text, message_id AS "messageId" FROM ${sql.unsafe(rel.messages)}
        WHERE thread_id = ${threadId} AND role = 'user' AND message_id NOT LIKE 'personal-%'
        ORDER BY created_at DESC LIMIT 30
      `;
      const first = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId" FROM ${sql.unsafe(rel.messages)}
        WHERE thread_id = ${threadId} AND role = 'user'
        ORDER BY created_at ASC LIMIT 1
      `;
      // The message that started the turn running now, not just the newest
      // one: a message queued during a task turn has not started anything.
      const latest = yield* sql<{ readonly messageId: string; readonly text: string }>`
        SELECT m.message_id AS "messageId", m.text AS "text"
        FROM ${sql.unsafe(rel.sessions)} s
        JOIN ${sql.unsafe(rel.turns)} t ON t.thread_id = s.thread_id AND t.turn_id = s.active_turn_id
        JOIN ${sql.unsafe(rel.messages)} m ON m.message_id = t.pending_message_id
        WHERE s.thread_id = ${threadId} AND m.role = 'user'
        LIMIT 1
      `;
      return {
        startedByOwner: first[0] !== undefined && isOwnerMessageId(first[0].messageId),
        texts: recent.map((row) => row.text),
        messageIds: recent.map((row) => row.messageId),
        current:
          latest[0] === undefined
            ? null
            : { text: latest[0].text, byOwner: isOwnerMessageId(latest[0].messageId) },
      };
    }).pipe(Effect.orElseSucceed(() => ({ startedByOwner: false, texts: [], current: null })));

  /** Whether any turn of the thread used a web or browser tool (the same tools as `readWeb`). */
  const threadUsedWeb = (threadId: ThreadId) =>
    engine.threadUsedWeb({ threadId, needles: WEB_TOOL_NEEDLES });

  const noteOrigin: PersonalMemoryService["Service"]["noteOrigin"] = (threadId) =>
    Effect.gen(function* () {
      // Web search, page reads, the shared browser, fetch tools: anywhere in the thread.
      const threadReadWeb = yield* threadUsedWeb(threadId);
      const turn = yield* sql<{
        readonly messageId: string;
        readonly requestedAt: string;
        readonly taskSource: string | null;
      }>`
        SELECT m.message_id AS "messageId", t.requested_at AS "requestedAt",
          (SELECT pt.source FROM personal_tasks pt WHERE pt.thread_id = s.thread_id
            ORDER BY pt.created_at DESC LIMIT 1) AS "taskSource"
        FROM ${sql.unsafe(rel.sessions)} s
        JOIN ${sql.unsafe(rel.turns)} t ON t.thread_id = s.thread_id AND t.turn_id = s.active_turn_id
        JOIN ${sql.unsafe(rel.messages)} m ON m.message_id = t.pending_message_id
        WHERE s.thread_id = ${threadId}
        LIMIT 1
      `;
      const current = turn[0];
      if (current === undefined) {
        return { origin: "app" as const, readWeb: false, threadReadWeb };
      }
      const id = current.messageId;
      const origin = originOfMessage(id, current.taskSource);
      // In this turn.
      const tools = yield* engine.toolStepsSince({
        threadId,
        since: current.requestedAt,
        limit: 2000,
      });
      const readWeb = usedWebTool(tools);
      return { origin, messageId: id, readWeb, threadReadWeb: threadReadWeb || readWeb };
    }).pipe(
      Effect.orElseSucceed(() => ({
        origin: "app" as const,
        readWeb: false,
        // Not knowing is not "no web": the strict reading applies.
        threadReadWeb: true,
      })),
    );

  return { ownerMessages, noteOrigin, threadUsedWeb };
};

export type MemoryProvenance = ReturnType<typeof makeMemoryProvenance>;
