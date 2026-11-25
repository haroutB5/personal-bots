import type {
  EnvironmentId,
  EventId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { EnvironmentThreadShell, OrchestrationLatestTurn } from "../bots/threadShell.ts";
import { USER_MESSAGE_DELIVERED_KIND } from "../feed/messageReadStatus.ts";
import type {
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThreadActivity,
} from "./wireTypes.ts";
import type { OrchestrationSession } from "@t3tools/contracts";
import { humanizeToolName } from "./liveWork.ts";

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
  if (item.type === "dynamic_tool" && item.toolName !== null && item.toolName.trim().length > 0) {
    const label = humanizeToolName(item.toolName);
    if (label.length > 0) return label;
  }
  return item.type
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function isUserMessageDelivered(
  item: Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }>,
  runsById: ReadonlyMap<string, OrchestrationV2Run>,
): boolean {
  if (item.inputIntent === "steer" || item.inputIntent === "promoted_queued_to_steer") {
    return item.status === "completed";
  }
  if (item.runId === null) return false;
  const run = runsById.get(item.runId);
  return run !== undefined && run.startedAt !== null;
}

const MESSAGE_CACHE = new WeakMap<OrchestrationV2ConversationMessage, OrchestrationMessage>();
const ACTIVITY_CACHE = new WeakMap<OrchestrationV2TurnItem, OrchestrationThreadActivity>();
const DELIVERED_ACTIVITY_CACHE = new WeakMap<
  OrchestrationV2TurnItem,
  OrchestrationThreadActivity
>();

function projectMessage(message: OrchestrationV2ConversationMessage): OrchestrationMessage {
  let cached = MESSAGE_CACHE.get(message);
  if (cached === undefined) {
    cached = {
      id: message.id,
      role: message.role,
      text: message.text,
      attachments: message.attachments,
      context: message.context,
      turnId: message.runId as unknown as TurnId | null,
      streaming: message.streaming,
      createdAt: DateTime.formatIso(message.createdAt),
      updatedAt: DateTime.formatIso(message.updatedAt),
    };
    MESSAGE_CACHE.set(message, cached);
  }
  return cached;
}

function projectDeliveredActivity(
  item: Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }>,
): OrchestrationThreadActivity {
  let cached = DELIVERED_ACTIVITY_CACHE.get(item);
  if (cached === undefined) {
    cached = {
      id: `${item.id}:delivered` as unknown as EventId,
      tone: "info",
      kind: USER_MESSAGE_DELIVERED_KIND,
      summary: "Message read",
      payload: { messageId: item.messageId },
      turnId: item.runId as unknown as TurnId | null,
      sequence: item.ordinal,
      createdAt: DateTime.formatIso(item.completedAt ?? item.updatedAt),
    };
    DELIVERED_ACTIVITY_CACHE.set(item, cached);
  }
  return cached;
}

function projectTurnActivity(item: OrchestrationV2TurnItem): OrchestrationThreadActivity {
  let cached = ACTIVITY_CACHE.get(item);
  if (cached === undefined) {
    cached = {
      id: item.id as unknown as EventId,
      tone: activityTone(item),
      kind: item.type,
      summary: activitySummary(item),
      payload: item,
      turnId: item.runId as unknown as TurnId | null,
      sequence: item.ordinal,
      createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
    };
    ACTIVITY_CACHE.set(item, cached);
  }
  return cached;
}

export function toChatThread(
  environmentId: EnvironmentId,
  projection: OrchestrationV2ThreadProjection,
): ChatThread {
  const thread = projection.thread;
  const runsById = new Map<string, OrchestrationV2Run>();
  for (const run of projection.runs) runsById.set(run.id, run);
  const messages: ReadonlyArray<OrchestrationMessage> = projection.messages.map(projectMessage);
  let threadCreatedIso: string | undefined;
  let threadUpdatedIso: string | undefined;
  const getThreadCreatedIso = () => (threadCreatedIso ??= DateTime.formatIso(thread.createdAt));
  const getThreadUpdatedIso = () => (threadUpdatedIso ??= DateTime.formatIso(thread.updatedAt));
  const proposedPlans: ReadonlyArray<OrchestrationProposedPlan> =
    projection.plans.length === 0
      ? []
      : projection.plans
          .filter((plan) => plan.kind === "proposed_plan")
          .map((plan) => ({
            id: String(plan.id),
            turnId: plan.runId as unknown as TurnId | null,
            planMarkdown: plan.markdown,
            implementedAt: plan.status === "completed" ? getThreadUpdatedIso() : null,
            implementationThreadId: null,
            createdAt: getThreadCreatedIso(),
            updatedAt: getThreadUpdatedIso(),
          }));
  const activities: Array<OrchestrationThreadActivity> = [];
  for (const row of projection.visibleTurnItems) {
    const item = row.item;
    if (item.type === "user_message") {
      if (isUserMessageDelivered(item, runsById)) {
        activities.push(projectDeliveredActivity(item));
      }
      continue;
    }
    if (MESSAGE_ITEM_TYPES.has(item.type)) continue;
    activities.push(projectTurnActivity(item));
  }
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
    createdAt: getThreadCreatedIso(),
    updatedAt: getThreadUpdatedIso(),
    archivedAt: thread.archivedAt === null ? null : DateTime.formatIso(thread.archivedAt),
    session,
    latestTurn,
    messages,
    proposedPlans,
    activities,
  };
}
