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
  const { sql } = core;

  const ownerMessages: PersonalMemoryService["Service"]["ownerMessages"] = (threadId) =>
    Effect.gen(function* () {
      // App-written user-role messages all carry a "personal-" id (task and
      // steer briefs, routine runs, group relays, notices, lead answers).
      const recent = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND role = 'user' AND message_id NOT LIKE 'personal-%'
        ORDER BY created_at DESC LIMIT 30
      `;
      const first = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId" FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND role = 'user'
        ORDER BY created_at ASC LIMIT 1
      `;
      // The message that started the turn running now, not just the newest
      // one: a message queued during a task turn has not started anything.
      const latest = yield* sql<{ readonly messageId: string; readonly text: string }>`
        SELECT m.message_id AS "messageId", m.text AS "text"
        FROM projection_thread_sessions s
        JOIN projection_turns t ON t.thread_id = s.thread_id AND t.turn_id = s.active_turn_id
        JOIN projection_thread_messages m ON m.message_id = t.pending_message_id
        WHERE s.thread_id = ${threadId} AND m.role = 'user'
        LIMIT 1
      `;
      return {
        startedByOwner: first[0] !== undefined && isOwnerMessageId(first[0].messageId),
        texts: recent.map((row) => row.text),
        current:
          latest[0] === undefined
            ? null
            : { text: latest[0].text, byOwner: isOwnerMessageId(latest[0].messageId) },
      };
    }).pipe(Effect.orElseSucceed(() => ({ startedByOwner: false, texts: [], current: null })));

  /** Whether any turn of the thread used a web or browser tool (the same tools as `readWeb`). */
  const threadUsedWeb = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly found: number }>`
        SELECT 1 AS "found"
        FROM projection_thread_activities a
        WHERE a.thread_id = ${threadId} AND a.kind LIKE 'tool.%'
          AND (
            json_extract(a.payload_json, '$.itemType') = 'web_search'
            OR ${sql.or(
              WEB_TOOL_NEEDLES.map(
                (needle) =>
                  sql`instr(lower(a.summary || ' ' || COALESCE(json_extract(a.payload_json, '$.title'), '') || ' ' || substr(COALESCE(json_extract(a.payload_json, '$.detail'), ''), 1, 80)), ${needle}) > 0`,
              ),
            )}
          )
        LIMIT 1
      `;
      return rows.length > 0;
    });

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
        FROM projection_thread_sessions s
        JOIN projection_turns t ON t.thread_id = s.thread_id AND t.turn_id = s.active_turn_id
        JOIN projection_thread_messages m ON m.message_id = t.pending_message_id
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
      const tools = yield* sql<{ readonly itemType: string | null; readonly text: string }>`
        SELECT json_extract(a.payload_json, '$.itemType') AS "itemType",
          a.summary || ' ' || COALESCE(json_extract(a.payload_json, '$.title'), '') || ' '
            || substr(COALESCE(json_extract(a.payload_json, '$.detail'), ''), 1, 80) AS "text"
        FROM projection_thread_activities a
        WHERE a.thread_id = ${threadId} AND a.kind LIKE 'tool.%'
          AND a.created_at >= ${current.requestedAt}
        LIMIT 2000
      `;
      const readWeb = usedWebTool(tools);
      return { origin, readWeb, threadReadWeb: threadReadWeb || readWeb };
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
