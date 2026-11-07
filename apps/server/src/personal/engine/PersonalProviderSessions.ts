/**
 * The v2 home of the session list, session stop and session events. A host
 * without the session services gets an empty list, a no-op stop and an empty stream.
 */
import {
  type OrchestrationV2DomainEvent,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  TrimmedNonEmptyString,
  type ProviderSession,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import type { PersonalSessionEvent } from "./PersonalProviders.ts";
import { failureDetail, PersonalProvidersError } from "./errors.ts";

const WORKING_RUN_STATUSES = ["preparing", "starting", "running", "waiting"] as const;
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

interface SessionRow {
  readonly thread_id: string;
  readonly payload_json: string;
  readonly active_run_id: string | null;
}

/** The stored session minus its capability tree, which listing never reads. */
const StoredSession = Schema.Struct({
  id: ProviderSessionId,
  driver: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  status: Schema.Literals(["starting", "ready", "running", "waiting", "stopped", "error"]),
  cwd: TrimmedNonEmptyString,
  model: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  lastError: Schema.NullOr(Schema.String),
});
type StoredSession = typeof StoredSession.Type;

const decodeSession = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredSession));

const wireStatus = (status: StoredSession["status"]): ProviderSession["status"] => {
  switch (status) {
    case "starting":
      return "connecting";
    case "ready":
      return "ready";
    case "running":
    case "waiting":
      return "running";
    case "stopped":
      return "closed";
    case "error":
      return "error";
  }
};

const toWire = (
  threadId: ThreadId,
  session: StoredSession,
  activeRunId: string | null,
): ProviderSession => ({
  provider: session.driver,
  providerInstanceId: session.providerInstanceId,
  status: wireStatus(session.status),
  runtimeMode: "full-access",
  cwd: session.cwd,
  ...(session.model === null ? {} : { model: session.model }),
  threadId,
  ...(activeRunId === null ? {} : { activeTurnId: TurnId.make(activeRunId) }),
  createdAt: DateTime.formatIso(session.createdAt),
  updatedAt: DateTime.formatIso(session.updatedAt),
  ...(session.lastError === null ? {} : { lastError: session.lastError }),
});

export const sessionEventsOf = (
  event: OrchestrationV2DomainEvent,
): ReadonlyArray<PersonalSessionEvent> => {
  switch (event.type) {
    case "provider-session.attached":
      return [
        {
          _tag: "SessionStarted",
          threadId: event.threadId,
          instanceId: event.payload.providerInstanceId,
        },
      ];
    case "provider-session.detached":
      return [{ _tag: "SessionExited", threadId: event.threadId }];
    case "run.updated":
      return TERMINAL_RUN_STATUSES.has(event.payload.status)
        ? [{ _tag: "TurnSettled", threadId: event.threadId }]
        : [];
    default:
      return [];
  }
};

export class PersonalProviderSessions extends Context.Service<
  PersonalProviderSessions,
  {
    readonly listSessions: () => Effect.Effect<
      ReadonlyArray<ProviderSession>,
      PersonalProvidersError
    >;
    readonly stopSession: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<void, PersonalProvidersError>;
    readonly sessionEvents: Stream.Stream<PersonalSessionEvent>;
  }
>()("t3/personal/engine/PersonalProviderSessions") {}

const providersError = (operation: string) => (failure: unknown) =>
  new PersonalProvidersError({ operation, detail: failureDetail(failure) });

export const layerLive = Layer.effect(
  PersonalProviderSessions,
  Effect.gen(function* () {
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    const sessions = yield* Effect.serviceOption(ProviderSessionManagerV2);
    const orchestrator = yield* Effect.serviceOption(OrchestratorV2);

    const readBindings = (client: SqlClient.SqlClient, threadId?: ThreadId) =>
      client<SessionRow>`
        SELECT binding.thread_id AS thread_id,
          session.payload_json AS payload_json,
          (
            SELECT run.run_id FROM orchestration_v2_projection_runs run
            WHERE run.thread_id = binding.thread_id
              AND run.status IN ${client.in(WORKING_RUN_STATUSES)}
            ORDER BY run.ordinal DESC
            LIMIT 1
          ) AS active_run_id
        FROM orchestration_v2_projection_provider_session_bindings binding
        JOIN orchestration_v2_projection_provider_sessions session
          ON session.provider_session_id = binding.provider_session_id
        WHERE session.status NOT IN ('stopped', 'error')
          ${threadId === undefined ? client`` : client`AND binding.thread_id = ${threadId}`}
      `;

    const listSessions: PersonalProviderSessions["Service"]["listSessions"] = () =>
      Effect.gen(function* () {
        if (Option.isNone(sql) || Option.isNone(sessions)) return [];
        const rows = yield* readBindings(sql.value);
        const live: Array<ProviderSession> = [];
        for (const row of rows) {
          const session = yield* decodeSession(row.payload_json);
          if (!(yield* sessions.value.isLive(session.id))) continue;
          live.push(toWire(row.thread_id as ThreadId, session, row.active_run_id));
        }
        return live;
      }).pipe(Effect.mapError(providersError("listSessions")));

    const stopSession: PersonalProviderSessions["Service"]["stopSession"] = ({ threadId }) =>
      Effect.gen(function* () {
        if (Option.isNone(sql) || Option.isNone(sessions)) return;
        const rows = yield* readBindings(sql.value, threadId);
        for (const row of rows) {
          const session = yield* decodeSession(row.payload_json);
          const providerSessionId = ProviderSessionId.make(session.id);
          const others = yield* sessions.value.otherWorkingThreads({ providerSessionId, threadId });
          yield* others.length > 0
            ? sessions.value.detach({ providerSessionId, threadId, detail: "personal stop" })
            : sessions.value.release({ providerSessionId, reason: "manual_shutdown" });
        }
      }).pipe(Effect.mapError(providersError("stopSession")));

    const sessionEvents: PersonalProviderSessions["Service"]["sessionEvents"] = Option.isNone(
      orchestrator,
    )
      ? Stream.empty
      : orchestrator.value.streamDomainEvents.pipe(
          Stream.catch(() => Stream.empty),
          Stream.flatMap((event) => Stream.fromIterable(sessionEventsOf(event))),
        );

    return { listSessions, stopSession, sessionEvents };
  }),
);

export const layer = layerLive;
