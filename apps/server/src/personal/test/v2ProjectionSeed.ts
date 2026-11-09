import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export interface SeedThread {
  readonly threadId: string;
  readonly projectId?: string;
  readonly title?: string;
  readonly instanceId?: string;
  readonly model?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
  readonly pinnedAt?: string | null;
  readonly settledOverride?: "settled" | "active" | null;
}

export interface SeedMessage {
  readonly messageId: string;
  readonly threadId: string;
  readonly role?: string;
  readonly text?: string;
  readonly streaming?: boolean;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly context?: unknown;
  readonly attachments?: ReadonlyArray<unknown>;
}

export interface SeedRun {
  readonly runId: string;
  readonly threadId: string;
  readonly ordinal?: number;
  readonly status?: string;
  readonly requestedAt?: string;
  readonly completedAt?: string | null;
  readonly userMessageId?: string | null;
  readonly instanceId?: string;
}

export interface SeedProviderThread {
  readonly threadId: string;
  readonly driver: string;
  readonly nativeId: string | null;
  readonly providerThreadId?: string;
  readonly lastRunOrdinal?: number;
  readonly instanceId?: string;
}

export interface SeedRuntimeRequest {
  readonly requestId: string;
  readonly threadId: string;
  readonly kind?: string;
  readonly status?: string;
}

const EPOCH = "2026-01-01T00:00:00.000Z";

export const seedV2Thread = (input: SeedThread) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const createdAt = input.createdAt ?? EPOCH;
    const updatedAt = input.updatedAt ?? createdAt;
    const instanceId = input.instanceId ?? "codex";
    const modelSelection = { instanceId, model: input.model ?? "m" };
    const payload = JSON.stringify({
      createdBy: "system",
      creationSource: "server",
      id: input.threadId,
      projectId: input.projectId ?? "project-seed",
      title: input.title ?? "",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
      forkedFrom: null,
      createdAt,
      updatedAt,
      archivedAt: input.archivedAt ?? null,
      settledOverride: input.settledOverride ?? null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: input.deletedAt ?? null,
      ...(input.pinnedAt === undefined || input.pinnedAt === null
        ? {}
        : { pinnedAt: input.pinnedAt }),
    });
    yield* sql`
      INSERT OR REPLACE INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode,
          interaction_mode, active_provider_thread_id, created_at, updated_at, archived_at,
          deleted_at, payload_json)
      VALUES (${input.threadId}, ${input.projectId ?? "project-seed"}, ${input.title ?? ""},
        ${instanceId}, ${instanceId}, 'full-access', 'default', NULL, ${createdAt}, ${updatedAt},
        ${input.archivedAt ?? null}, ${input.deletedAt ?? null}, ${payload})
    `;
  });

export const seedV2Message = (input: SeedMessage) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const createdAt = input.createdAt ?? EPOCH;
    const updatedAt = input.updatedAt ?? createdAt;
    const payload = JSON.stringify({
      id: input.messageId,
      threadId: input.threadId,
      role: input.role ?? "user",
      text: input.text ?? "",
      attachments: input.attachments ?? [],
      ...(input.context === undefined ? {} : { context: input.context }),
      streaming: input.streaming ?? false,
      createdAt,
      updatedAt,
    });
    yield* sql`
      INSERT OR REPLACE INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (${input.messageId}, ${input.threadId}, NULL, NULL, ${input.role ?? "user"},
        ${input.streaming === true ? 1 : 0}, ${createdAt}, ${updatedAt}, ${payload})
    `;
  });

export const seedV2Run = (input: SeedRun) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const requestedAt = input.requestedAt ?? EPOCH;
    const instanceId = input.instanceId ?? "codex";
    const payload = JSON.stringify({
      id: input.runId,
      userMessageId: input.userMessageId ?? null,
      providerInstanceId: instanceId,
    });
    yield* sql`
      INSERT OR REPLACE INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_instance_id, provider_thread_id, status,
          requested_at, completed_at, payload_json)
      VALUES (${input.runId}, ${input.threadId}, ${input.ordinal ?? 1}, ${instanceId},
        ${instanceId}, NULL, ${input.status ?? "running"}, ${requestedAt},
        ${input.completedAt ?? null}, ${payload})
    `;
  });

export const seedV2ProviderThread = (input: SeedProviderThread) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const providerThreadId = input.providerThreadId ?? `pt-${input.threadId}`;
    const instanceId = input.instanceId ?? input.driver;
    const payload = JSON.stringify({
      id: providerThreadId,
      driver: input.driver,
      providerInstanceId: instanceId,
      appThreadId: input.threadId,
      nativeThreadRef:
        input.nativeId === null
          ? null
          : { driver: input.driver, nativeId: input.nativeId, strength: "strong" },
    });
    yield* sql`
      INSERT OR REPLACE INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, owner_node_id, provider, driver, provider_instance_id,
          provider_session_id, status, first_run_ordinal, last_run_ordinal, updated_at, payload_json)
      VALUES (${providerThreadId}, ${input.threadId}, NULL, ${input.driver}, ${input.driver},
        ${instanceId}, NULL, 'idle', 1, ${input.lastRunOrdinal ?? 1}, ${EPOCH}, ${payload})
    `;
  });

export const seedV2RuntimeRequest = (input: SeedRuntimeRequest) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT OR REPLACE INTO orchestration_v2_projection_runtime_requests
        (runtime_request_id, thread_id, node_id, provider_turn_id, kind, status, created_at,
          resolved_at, payload_json)
      VALUES (${input.requestId}, ${input.threadId}, 'node-seed', NULL, ${input.kind ?? "approval"},
        ${input.status ?? "pending"}, ${EPOCH}, NULL, '{}')
    `;
  });
