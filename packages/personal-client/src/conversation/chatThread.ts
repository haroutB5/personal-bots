import type {
  EnvironmentId,
  EventId,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { EnvironmentThreadShell, OrchestrationLatestTurn } from "../bots/threadShell.ts";
import type {
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThreadActivity,
} from "./wireTypes.ts";
import type { OrchestrationSession } from "@t3tools/contracts";

/**
 * The chat shapes Main's phone screens render. The merged server sends the v2
 * projection, whose thread is split into messages, plans and turn items; this
 * view joins them back into one thread so the screens keep their v1 rows.
 */
export interface ChatThread {
  readonly id: EnvironmentThreadShell["id"];
  readonly projectId: EnvironmentThreadShell["projectId"];
  readonly title: string;
  readonly modelSelection: EnvironmentThreadShell["modelSelection"];
  readonly runtimeMode: EnvironmentThreadShell["runtimeMode"];
  readonly interactionMode: EnvironmentThreadShell["interactionMode"];
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly session: OrchestrationSession | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly proposedPlans: ReadonlyArray<OrchestrationProposedPlan>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly environmentId: EnvironmentId;
}

const MESSAGE_ITEM_TYPES: ReadonlySet<string> = new Set([
  "user_message",
  "assistant_message",
  "reasoning",
]);

const APPROVAL_ITEM_TYPES: ReadonlySet<string> = new Set([
  "approval_request",
  "user_input_request",
  "secret_request",
  "link_request",
]);

function runState(status: string): OrchestrationLatestTurn["state"] {
  if (status === "running" || status === "waiting") return "running";
  if (status === "interrupted") return "interrupted";
  if (status === "failed") return "error";
  return "completed";
}

function sessionStatus(status: string): OrchestrationSession["status"] {
  switch (status) {
    case "preparing":
    case "queued":
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "error";
    case "cancelled":
    case "rolled_back":
      return "stopped";
    default:
      return "ready";
  }
}

function activityTone(item: OrchestrationV2TurnItem): OrchestrationThreadActivity["tone"] {
  if (item.status === "failed") return "error";
  return APPROVAL_ITEM_TYPES.has(item.type) ? "approval" : "tool";
}

function activitySummary(item: OrchestrationV2TurnItem): string {
  if (item.title !== null && item.title.trim().length > 0) return item.title;
  return item.type
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function toChatThread(
  environmentId: EnvironmentId,
  projection: OrchestrationV2ThreadProjection,
): ChatThread {
  const thread = projection.thread;
  const messages: ReadonlyArray<OrchestrationMessage> = projection.messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    attachments: message.attachments,
    context: message.context,
    turnId: message.runId as unknown as TurnId | null,
    streaming: message.streaming,
    createdAt: DateTime.formatIso(message.createdAt),
    updatedAt: DateTime.formatIso(message.updatedAt),
  }));
  const proposedPlans: ReadonlyArray<OrchestrationProposedPlan> = projection.plans
    .filter((plan) => plan.kind === "proposed_plan")
    .map((plan) => ({
      id: String(plan.id),
      turnId: plan.runId as unknown as TurnId | null,
      planMarkdown: plan.markdown,
      implementedAt: plan.status === "completed" ? DateTime.formatIso(thread.updatedAt) : null,
      implementationThreadId: null,
      createdAt: DateTime.formatIso(thread.createdAt),
      updatedAt: DateTime.formatIso(thread.updatedAt),
    }));
  const activities: ReadonlyArray<OrchestrationThreadActivity> = projection.visibleTurnItems
    .map((row) => row.item)
    .filter((item) => !MESSAGE_ITEM_TYPES.has(item.type))
    .map((item) => ({
      id: item.id as unknown as EventId,
      tone: activityTone(item),
      kind: item.type,
      summary: activitySummary(item),
      payload: item,
      turnId: item.runId as unknown as TurnId | null,
      sequence: item.ordinal,
      createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
    }));
  const latestRun = projection.runs.at(-1) ?? null;
  const latestAssistant = messages.findLast((message) => message.role === "assistant") ?? null;
  const latestTurn: OrchestrationLatestTurn | null =
    latestRun === null
      ? null
      : {
          turnId: latestRun.id as unknown as TurnId,
          state: runState(latestRun.status),
          requestedAt: DateTime.formatIso(latestRun.requestedAt),
          startedAt: latestRun.startedAt === null ? null : DateTime.formatIso(latestRun.startedAt),
          completedAt:
            latestRun.completedAt === null ? null : DateTime.formatIso(latestRun.completedAt),
          assistantMessageId: latestAssistant?.id ?? null,
        };
  const session: OrchestrationSession | null =
    latestRun === null
      ? null
      : {
          threadId: thread.id,
          status: sessionStatus(latestRun.status),
          providerName: projection.providerSessions.at(-1)?.driver ?? null,
          providerInstanceId: latestRun.providerInstanceId,
          runtimeMode: thread.runtimeMode,
          activeTurnId:
            latestRun.status === "running" || latestRun.status === "waiting"
              ? (latestRun.id as unknown as TurnId)
              : null,
          lastError: latestRun.status === "failed" ? "The last turn failed." : null,
          updatedAt: DateTime.formatIso(
            latestRun.completedAt ?? latestRun.startedAt ?? latestRun.requestedAt,
          ),
        };

  return {
    environmentId,
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    createdAt: DateTime.formatIso(thread.createdAt),
    updatedAt: DateTime.formatIso(thread.updatedAt),
    archivedAt: thread.archivedAt === null ? null : DateTime.formatIso(thread.archivedAt),
    session,
    latestTurn,
    messages,
    proposedPlans,
    activities,
  };
}
