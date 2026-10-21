import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "./ProviderSessionRuntime.ts";

const testLayer = ProviderSessionRuntime.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const runtime = (
  threadId: string,
  resume: string,
): ProviderSessionRuntime.ProviderSessionRuntime => ({
  threadId: ThreadId.make(threadId),
  providerName: "claudeAgent",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  adapterKey: "claudeAgent",
  runtimeMode: "full-access",
  status: "running",
  lastSeenAt: "2026-10-21T10:00:00.000Z",
  resumeCursor: { resume, turnCount: 1 },
  runtimePayload: null,
});

it.layer(testLayer)("ProviderSessionRuntime session history", (it) => {
  it.effect("remembers every session a chat resumes, not only the current one", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-history");

      yield* repository.upsert(runtime("thread-history", "session-a"));
      yield* repository.upsert(runtime("thread-history", "session-b"));
      // A repeated sighting of one session must not add another row.
      yield* repository.upsert(runtime("thread-history", "session-a"));

      const rows = yield* sql<{ readonly sessionId: string }>`
        SELECT session_id AS "sessionId" FROM provider_session_history
        WHERE thread_id = ${threadId}
        ORDER BY session_id
      `;
      assert.deepStrictEqual(
        rows.map((row) => row.sessionId),
        ["session-a", "session-b"],
      );
    }),
  );

  it.effect("records nothing for a provider whose cursor names no session", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* repository.upsert({
        ...runtime("thread-opencode", "session-c"),
        providerName: "opencode",
        resumeCursor: { threadId: "not-a-session-field" },
      });
      const rows = yield* sql`
        SELECT session_id AS "sessionId" FROM provider_session_history
        WHERE thread_id = ${ThreadId.make("thread-opencode")}
      `;
      assert.deepStrictEqual(rows, []);
    }),
  );

  it.effect("leaves the history empty when the kill switch is off", () => {
    const previous = process.env.PERSONAL_TOKEN_USAGE_SESSION_HISTORY;
    process.env.PERSONAL_TOKEN_USAGE_SESSION_HISTORY = "off";
    return Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* repository.upsert(runtime("thread-off", "session-off"));
      const rows = yield* sql`
        SELECT session_id AS "sessionId" FROM provider_session_history
        WHERE thread_id = ${ThreadId.make("thread-off")}
      `;
      assert.deepStrictEqual(rows, []);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env.PERSONAL_TOKEN_USAGE_SESSION_HISTORY;
          else process.env.PERSONAL_TOKEN_USAGE_SESSION_HISTORY = previous;
        }),
      ),
    );
  });
});
