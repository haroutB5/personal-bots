import { ProviderSessionId, type OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import {
  PersonalProviderSessions,
  layer as sessionsLayer,
  sessionEventsOf,
} from "./PersonalProviderSessions.ts";

const THREAD = ThreadId.make("thread-1");
const OTHER = ThreadId.make("thread-2");
const SESSION = ProviderSessionId.make("session-1");
const STOPPED = ProviderSessionId.make("session-2");

const sessionPayload = (id: string, status: string) =>
  JSON.stringify({
    id,
    driver: "claudeAgent",
    providerInstanceId: "claudeAgent",
    status,
    cwd: "/tmp/work",
    model: "opus",
    capabilities: {},
    createdAt: "2026-11-07T00:00:00.000Z",
    updatedAt: "2026-11-07T00:00:00.000Z",
    lastError: null,
  });

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [id, status] of [
    [SESSION, "ready"],
    [STOPPED, "stopped"],
  ] as const) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_sessions (
        provider_session_id, thread_id, provider, status, model, updated_at, payload_json
      ) VALUES (${id}, ${THREAD}, 'claudeAgent', ${status}, 'opus', '2026-11-07T00:00:00.000Z',
        ${sessionPayload(id, status)})
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_session_bindings (provider_session_id, thread_id)
      VALUES (${id}, ${THREAD})
    `;
  }
});

const setup = (options: { readonly others: ReadonlyArray<ThreadId>; readonly live: boolean }) => {
  const calls: Array<string> = [];
  const manager = Layer.mock(ProviderSessionManagerV2)({
    isLive: () => Effect.succeed(options.live),
    otherWorkingThreads: () => Effect.succeed(options.others),
    detach: () => Effect.sync(() => void calls.push("detach")),
    release: (input) => Effect.sync(() => void calls.push(`release:${input.reason}`)),
  });
  const layer = sessionsLayer.pipe(
    Layer.provideMerge(manager),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return { calls, layer };
};

describe("PersonalProviderSessions", () => {
  it.effect("lists live, non-stopped sessions with their thread", () => {
    const { layer } = setup({ others: [], live: true });
    return Effect.gen(function* () {
      yield* seed;
      const sessions = yield* PersonalProviderSessions;
      const listed = yield* sessions.listSessions();
      expect(listed.map((session) => [session.threadId, session.status])).toEqual([
        [THREAD, "ready"],
      ]);
      expect(listed[0]?.providerInstanceId).toBe("claudeAgent");
      expect(listed[0]?.activeTurnId).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("omits sessions the manager no longer holds live", () => {
    const { layer } = setup({ others: [], live: false });
    return Effect.gen(function* () {
      yield* seed;
      const sessions = yield* PersonalProviderSessions;
      expect(yield* sessions.listSessions()).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stop releases a session no other thread works on", () => {
    const { layer, calls } = setup({ others: [], live: true });
    return Effect.gen(function* () {
      yield* seed;
      const sessions = yield* PersonalProviderSessions;
      yield* sessions.stopSession({ threadId: THREAD });
      expect(calls).toEqual(["release:manual_shutdown"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stop detaches when another thread works on the shared session", () => {
    const { layer, calls } = setup({ others: [OTHER], live: true });
    return Effect.gen(function* () {
      yield* seed;
      const sessions = yield* PersonalProviderSessions;
      yield* sessions.stopSession({ threadId: THREAD });
      expect(calls).toEqual(["detach"]);
    }).pipe(Effect.provide(layer));
  });
});

describe("sessionEventsOf", () => {
  const base = { id: "event-1", threadId: THREAD, occurredAt: "2026-11-07T00:00:00.000Z" };
  const event = (value: unknown) => value as OrchestrationV2DomainEvent;

  it("maps attach, detach and terminal runs to the three session facts", () => {
    expect(
      sessionEventsOf(
        event({
          ...base,
          type: "provider-session.attached",
          payload: { providerInstanceId: "claudeAgent" },
        }),
      ),
    ).toEqual([{ _tag: "SessionStarted", threadId: THREAD, instanceId: "claudeAgent" }]);
    expect(
      sessionEventsOf(event({ ...base, type: "provider-session.detached", payload: {} })),
    ).toEqual([{ _tag: "SessionExited", threadId: THREAD }]);
    expect(
      sessionEventsOf(event({ ...base, type: "run.updated", payload: { status: "completed" } })),
    ).toEqual([{ _tag: "TurnSettled", threadId: THREAD }]);
  });

  it("ignores runs still working and unrelated events", () => {
    expect(
      sessionEventsOf(event({ ...base, type: "run.updated", payload: { status: "running" } })),
    ).toEqual([]);
    expect(sessionEventsOf(event({ ...base, type: "thread.deleted", payload: {} }))).toEqual([]);
  });
});
