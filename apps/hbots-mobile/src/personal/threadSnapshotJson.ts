import {
  OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadDetailSnapshot as ThreadSnapshot,
} from "@t3tools/contracts";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const CachedThreadSnapshot = Schema.Struct({
  ...OrchestrationV2ThreadDetailSnapshot.fields,
  turnItemsOmitLocalVisible: Schema.optional(Schema.Literal(true)),
});

const decodeCachedSnapshot = Schema.decodeUnknownSync(Schema.toCodecJson(CachedThreadSnapshot));

export function decodeThreadSnapshotJson(value: unknown): ThreadSnapshot {
  const { turnItemsOmitLocalVisible, ...snapshot } = decodeCachedSnapshot(value);
  return {
    ...snapshot,
    projection: boundedSnapshotProjection({
      projection: snapshot.projection,
      turnItemsOmitLocalVisible,
    }),
  };
}

type MutableRecord = Record<string, unknown>;

function reviveRequiredUtc(obj: MutableRecord, key: string): boolean {
  const value = obj[key];
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  obj[key] = DateTime.makeUnsafe(ms);
  return true;
}

function reviveNullableUtc(obj: MutableRecord, key: string): boolean {
  const value = obj[key];
  if (value === null) return true;
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  obj[key] = DateTime.makeUnsafe(ms);
  return true;
}

function reviveOptionalNullableUtc(obj: MutableRecord, key: string): boolean {
  const value = obj[key];
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  obj[key] = DateTime.makeUnsafe(ms);
  return true;
}

function reviveOptionalUtc(obj: MutableRecord, key: string): boolean {
  const value = obj[key];
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  obj[key] = DateTime.makeUnsafe(ms);
  return true;
}

function isObject(value: unknown): value is MutableRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reviveTurnItem(item: unknown): boolean {
  if (!isObject(item)) return false;
  if (
    !reviveNullableUtc(item, "startedAt") ||
    !reviveNullableUtc(item, "completedAt") ||
    !reviveRequiredUtc(item, "updatedAt")
  ) {
    return false;
  }
  if (item.type === "run_interrupt_request" && !reviveOptionalUtc(item, "unresponsiveAt")) {
    return false;
  }
  return true;
}

/**
 * Direct in-place DateTime.Utc reviver for AES-GCM authenticated thread snapshots written by this
 * app; returns `null` on any structural mismatch so the caller falls back to `decodeThreadSnapshotJson`.
 */
export function tryFastDecodeThreadSnapshotJson(
  raw: unknown,
  expectedThreadId: string,
): ThreadSnapshot | null {
  if (!isObject(raw)) return null;
  if (typeof raw.snapshotSequence !== "number" || !Number.isFinite(raw.snapshotSequence)) {
    return null;
  }
  const omitFlag = raw.turnItemsOmitLocalVisible;
  if (omitFlag !== undefined && omitFlag !== true) return null;

  const projection = raw.projection;
  if (!isObject(projection)) return null;
  if (!reviveRequiredUtc(projection, "updatedAt")) return null;

  const thread = projection.thread;
  if (!isObject(thread) || thread.id !== expectedThreadId) return null;
  if (
    !reviveRequiredUtc(thread, "createdAt") ||
    !reviveRequiredUtc(thread, "updatedAt") ||
    !reviveNullableUtc(thread, "archivedAt") ||
    !reviveOptionalNullableUtc(thread, "settledAt") ||
    !reviveOptionalNullableUtc(thread, "unsettledAt") ||
    !reviveOptionalNullableUtc(thread, "snoozedUntil") ||
    !reviveOptionalNullableUtc(thread, "snoozedAt") ||
    !reviveOptionalNullableUtc(thread, "lastSnoozeWakeAt") ||
    !reviveOptionalNullableUtc(thread, "pinnedAt") ||
    !reviveOptionalNullableUtc(thread, "autoSettleDisabledAt") ||
    !reviveOptionalNullableUtc(thread, "lastVisitedAt") ||
    !reviveNullableUtc(thread, "deletedAt")
  ) {
    return null;
  }
  if (thread.settledOverride === undefined) thread.settledOverride = null;
  if (thread.settledAt === undefined) thread.settledAt = null;
  if (thread.lastVisitedAt === undefined) thread.lastVisitedAt = null;
  if (thread.titleRegeneration !== undefined && thread.titleRegeneration !== null) {
    if (
      !isObject(thread.titleRegeneration) ||
      !reviveRequiredUtc(thread.titleRegeneration, "startedAt")
    ) {
      return null;
    }
  }
  if (thread.lastTitleRegeneration !== undefined && thread.lastTitleRegeneration !== null) {
    if (
      !isObject(thread.lastTitleRegeneration) ||
      !reviveRequiredUtc(thread.lastTitleRegeneration, "completedAt")
    ) {
      return null;
    }
  }

  const runs = projection.runs;
  const attempts = projection.attempts;
  const nodes = projection.nodes;
  const subagents = projection.subagents;
  const providerSessions = projection.providerSessions;
  const providerThreads = projection.providerThreads;
  const providerTurns = projection.providerTurns;
  const runtimeRequests = projection.runtimeRequests;
  const messages = projection.messages;
  const plans = projection.plans;
  const turnItems = projection.turnItems;
  const checkpointScopes = projection.checkpointScopes;
  const checkpoints = projection.checkpoints;
  const contextHandoffs = projection.contextHandoffs;
  const contextTransfers = projection.contextTransfers;
  const visibleTurnItems = projection.visibleTurnItems;

  if (
    !Array.isArray(runs) ||
    !Array.isArray(attempts) ||
    !Array.isArray(nodes) ||
    !Array.isArray(subagents) ||
    !Array.isArray(providerSessions) ||
    !Array.isArray(providerThreads) ||
    !Array.isArray(providerTurns) ||
    !Array.isArray(runtimeRequests) ||
    !Array.isArray(messages) ||
    !Array.isArray(plans) ||
    !Array.isArray(turnItems) ||
    !Array.isArray(checkpointScopes) ||
    !Array.isArray(checkpoints) ||
    !Array.isArray(contextHandoffs) ||
    !Array.isArray(contextTransfers) ||
    !Array.isArray(visibleTurnItems)
  ) {
    return null;
  }

  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    if (
      !isObject(run) ||
      !reviveRequiredUtc(run, "requestedAt") ||
      !reviveNullableUtc(run, "startedAt") ||
      !reviveNullableUtc(run, "completedAt") ||
      !reviveOptionalUtc(run, "workStartedAt")
    ) {
      return null;
    }
  }
  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    if (
      !isObject(attempt) ||
      !reviveNullableUtc(attempt, "startedAt") ||
      !reviveNullableUtc(attempt, "completedAt")
    ) {
      return null;
    }
  }
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (
      !isObject(node) ||
      !reviveNullableUtc(node, "startedAt") ||
      !reviveNullableUtc(node, "completedAt")
    ) {
      return null;
    }
  }
  for (let i = 0; i < subagents.length; i += 1) {
    const subagent = subagents[i];
    if (
      !isObject(subagent) ||
      !reviveNullableUtc(subagent, "startedAt") ||
      !reviveNullableUtc(subagent, "completedAt") ||
      !reviveRequiredUtc(subagent, "updatedAt")
    ) {
      return null;
    }
  }
  for (let i = 0; i < providerSessions.length; i += 1) {
    const session = providerSessions[i];
    if (
      !isObject(session) ||
      !reviveRequiredUtc(session, "createdAt") ||
      !reviveRequiredUtc(session, "updatedAt")
    ) {
      return null;
    }
    if (session.extensionStatuses === undefined) session.extensionStatuses = [];
  }
  for (let i = 0; i < providerThreads.length; i += 1) {
    const pt = providerThreads[i];
    if (
      !isObject(pt) ||
      !reviveRequiredUtc(pt, "createdAt") ||
      !reviveRequiredUtc(pt, "updatedAt")
    ) {
      return null;
    }
    if (pt.pendingBackgroundTasks === undefined) pt.pendingBackgroundTasks = [];
    if (pt.contextUsage === undefined) pt.contextUsage = null;
    if (pt.nativeMetadata === undefined) pt.nativeMetadata = null;
    if (pt.goal === undefined) pt.goal = null;
  }
  for (let i = 0; i < providerTurns.length; i += 1) {
    const pt = providerTurns[i];
    if (
      !isObject(pt) ||
      !reviveNullableUtc(pt, "startedAt") ||
      !reviveNullableUtc(pt, "completedAt")
    ) {
      return null;
    }
  }
  for (let i = 0; i < runtimeRequests.length; i += 1) {
    const req = runtimeRequests[i];
    if (
      !isObject(req) ||
      !reviveRequiredUtc(req, "createdAt") ||
      !reviveNullableUtc(req, "resolvedAt")
    ) {
      return null;
    }
  }
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (
      !isObject(msg) ||
      !reviveRequiredUtc(msg, "createdAt") ||
      !reviveRequiredUtc(msg, "updatedAt")
    ) {
      return null;
    }
  }
  for (let i = 0; i < turnItems.length; i += 1) {
    if (!reviveTurnItem(turnItems[i])) return null;
  }
  for (let i = 0; i < visibleTurnItems.length; i += 1) {
    const row = visibleTurnItems[i];
    if (!isObject(row) || !reviveTurnItem(row.item)) return null;
  }
  for (let i = 0; i < checkpointScopes.length; i += 1) {
    const scope = checkpointScopes[i];
    if (!isObject(scope) || !reviveRequiredUtc(scope, "createdAt")) return null;
  }
  for (let i = 0; i < checkpoints.length; i += 1) {
    const cp = checkpoints[i];
    if (!isObject(cp) || !reviveRequiredUtc(cp, "capturedAt")) return null;
  }
  for (let i = 0; i < contextHandoffs.length; i += 1) {
    const handoff = contextHandoffs[i];
    if (
      !isObject(handoff) ||
      !reviveRequiredUtc(handoff, "createdAt") ||
      !reviveRequiredUtc(handoff, "updatedAt")
    ) {
      return null;
    }
  }
  for (let i = 0; i < contextTransfers.length; i += 1) {
    const transfer = contextTransfers[i];
    if (
      !isObject(transfer) ||
      !reviveRequiredUtc(transfer, "createdAt") ||
      !reviveRequiredUtc(transfer, "updatedAt") ||
      !reviveNullableUtc(transfer, "consumedAt")
    ) {
      return null;
    }
  }

  const { turnItemsOmitLocalVisible, ...snapshot } = raw as unknown as ThreadSnapshot & {
    readonly turnItemsOmitLocalVisible?: true | undefined;
  };
  return {
    ...snapshot,
    projection: boundedSnapshotProjection({
      projection: snapshot.projection,
      turnItemsOmitLocalVisible,
    }),
  };
}
