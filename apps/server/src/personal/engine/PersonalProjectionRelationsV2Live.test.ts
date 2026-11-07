import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import {
  seedV2Message,
  seedV2ProviderThread,
  seedV2Run,
  seedV2RuntimeRequest,
  seedV2Thread,
} from "../test/v2ProjectionSeed.ts";
import { PERSONAL_V2_RELATIONS as rel } from "./PersonalProjectionRelationsV2Live.ts";

const query = <Row>(statement: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* sql.unsafe(statement)) as ReadonlyArray<Row>;
  });

describe("PersonalProjectionRelationsV2Live", () => {
  it.effect("threads carries the title, lifecycle stamps and payload flags", () =>
    Effect.gen(function* () {
      yield* seedV2Thread({
        threadId: "t-1",
        title: "Plan the trip",
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-02T00:00:00.000Z",
        archivedAt: "2026-02-03T00:00:00.000Z",
        pinnedAt: "2026-02-04T00:00:00.000Z",
        settledOverride: "settled",
      });
      const rows = yield* query<Record<string, unknown>>(
        `SELECT * FROM ${rel.threads} WHERE thread_id = 't-1'`,
      );
      expect(rows).toEqual([
        {
          thread_id: "t-1",
          title: "Plan the trip",
          created_at: "2026-02-01T00:00:00.000Z",
          updated_at: "2026-02-02T00:00:00.000Z",
          archived_at: "2026-02-03T00:00:00.000Z",
          deleted_at: null,
          pinned_at: "2026-02-04T00:00:00.000Z",
          settled_override: "settled",
          pending_approval_count: 0,
          pending_user_input_count: 0,
        },
      ]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("threads counts only pending requests, split by approval and user input", () =>
    Effect.gen(function* () {
      yield* seedV2Thread({ threadId: "t-1" });
      yield* seedV2Thread({ threadId: "t-2" });
      yield* seedV2RuntimeRequest({ requestId: "r-1", threadId: "t-1", kind: "approval" });
      yield* seedV2RuntimeRequest({ requestId: "r-2", threadId: "t-1", kind: "approval" });
      yield* seedV2RuntimeRequest({ requestId: "r-3", threadId: "t-1", kind: "user_input" });
      yield* seedV2RuntimeRequest({
        requestId: "r-4",
        threadId: "t-1",
        kind: "approval",
        status: "resolved",
      });
      yield* seedV2RuntimeRequest({ requestId: "r-5", threadId: "t-2", kind: "approval" });
      const rows = yield* query<{
        readonly thread_id: string;
        readonly pending_approval_count: number;
        readonly pending_user_input_count: number;
      }>(`SELECT * FROM ${rel.threads} ORDER BY thread_id`);
      expect(
        rows.map((row) => [
          row.thread_id,
          row.pending_approval_count,
          row.pending_user_input_count,
        ]),
      ).toEqual([
        ["t-1", 2, 1],
        ["t-2", 1, 0],
      ]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("messages exposes text, context, attachments and the streaming flag", () =>
    Effect.gen(function* () {
      yield* seedV2Thread({ threadId: "t-1" });
      yield* seedV2Message({
        messageId: "m-1",
        threadId: "t-1",
        role: "assistant",
        text: "Hello",
        streaming: true,
        context: [{ kind: "note" }],
        attachments: [{ id: "a-1" }],
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:05.000Z",
      });
      yield* seedV2Message({ messageId: "m-2", threadId: "t-1", text: "Plain" });
      const rows = yield* query<{
        readonly message_id: string;
        readonly role: string;
        readonly text: string;
        readonly context_json: string | null;
        readonly attachments_json: string | null;
        readonly is_streaming: number;
        readonly updated_at: string;
      }>(`SELECT * FROM ${rel.messages} ORDER BY message_id`);
      expect(rows[0]).toMatchObject({
        message_id: "m-1",
        role: "assistant",
        text: "Hello",
        is_streaming: 1,
        updated_at: "2026-02-01T00:00:05.000Z",
      });
      expect(JSON.parse(rows[0]?.context_json ?? "null")).toEqual([{ kind: "note" }]);
      expect(JSON.parse(rows[0]?.attachments_json ?? "null")).toEqual([{ id: "a-1" }]);
      expect(rows[1]).toMatchObject({ message_id: "m-2", is_streaming: 0, context_json: null });
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("sessions reads idle, starting and running off the newest working run", () =>
    Effect.gen(function* () {
      yield* seedV2Thread({ threadId: "idle", instanceId: "codex" });
      yield* seedV2Thread({ threadId: "done", instanceId: "codex" });
      yield* seedV2Run({
        runId: "run-done",
        threadId: "done",
        status: "completed",
        instanceId: "claudeAgent",
      });
      yield* seedV2Thread({ threadId: "starting" });
      yield* seedV2Run({ runId: "run-starting", threadId: "starting", status: "preparing" });
      yield* seedV2Thread({ threadId: "running" });
      yield* seedV2Run({ runId: "run-old", threadId: "running", ordinal: 1, status: "completed" });
      yield* seedV2Run({ runId: "run-new", threadId: "running", ordinal: 2, status: "waiting" });
      const rows = yield* query<{
        readonly thread_id: string;
        readonly status: string;
        readonly active_turn_id: string | null;
        readonly provider_instance_id: string;
      }>(`SELECT * FROM ${rel.sessions} ORDER BY thread_id`);
      expect(
        rows.map((row) => [
          row.thread_id,
          row.status,
          row.active_turn_id,
          row.provider_instance_id,
        ]),
      ).toEqual([
        ["done", "idle", null, "claudeAgent"],
        ["idle", "idle", null, "codex"],
        ["running", "running", "run-new", "codex"],
        ["starting", "starting", "run-starting", "codex"],
      ]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("turns maps each run to the message that started it", () =>
    Effect.gen(function* () {
      yield* seedV2Thread({ threadId: "t-1" });
      yield* seedV2Run({
        runId: "run-1",
        threadId: "t-1",
        requestedAt: "2026-02-01T00:00:00.000Z",
        userMessageId: "m-1",
      });
      const rows = yield* query<Record<string, unknown>>(`SELECT * FROM ${rel.turns}`);
      expect(rows).toEqual([
        {
          turn_id: "run-1",
          thread_id: "t-1",
          requested_at: "2026-02-01T00:00:00.000Z",
          pending_message_id: "m-1",
        },
      ]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("providerSessions keeps the newest provider thread with a resume cursor", () =>
    Effect.gen(function* () {
      yield* seedV2Thread({ threadId: "t-1" });
      yield* seedV2ProviderThread({
        threadId: "t-1",
        providerThreadId: "pt-old",
        driver: "claudeAgent",
        nativeId: "native-old",
        lastRunOrdinal: 1,
      });
      yield* seedV2ProviderThread({
        threadId: "t-1",
        providerThreadId: "pt-new",
        driver: "codex",
        nativeId: "native-new",
        lastRunOrdinal: 2,
      });
      const rows = yield* query<{
        readonly thread_id: string;
        readonly provider_name: string;
        readonly resume_cursor_json: string;
      }>(`SELECT * FROM ${rel.providerSessions}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.provider_name).toBe("codex");
      expect(JSON.parse(rows[0]?.resume_cursor_json ?? "null")).toEqual({
        resume: "native-new",
        threadId: "native-new",
        sessionId: "native-new",
      });
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
