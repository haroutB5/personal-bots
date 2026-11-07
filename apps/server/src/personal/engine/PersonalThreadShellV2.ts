/**
 * v2 thread shell mapped onto the v1 wire shape the personal contract uses.
 *
 * The v2 shell carries the run and the runtime state. The extras carry what
 * only the personal layer knows: the provider driver, the retry marker and the
 * title state.
 *
 * @module personal/engine/PersonalThreadShellV2
 */
import type {
  OrchestrationSession,
  OrchestrationThreadShell,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ShellThreadStatus,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { TurnId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { PersonalProviderRetryView, PersonalThreadStatus } from "./PersonalEngine.ts";

type SessionStatus = OrchestrationSession["status"];

export interface PersonalShellExtras {
  readonly providerName: string | null;
  readonly providerRetry: PersonalProviderRetryView | null;
  readonly titleState: OrchestrationThreadShell["titleState"];
}

export const EMPTY_SHELL_EXTRAS: PersonalShellExtras = {
  providerName: null,
  providerRetry: null,
  titleState: null,
};

const PERSONAL_STATUS: Record<SessionStatus, PersonalThreadStatus> = {
  idle: "idle",
  starting: "starting",
  running: "running",
  ready: "waiting",
  stopped: "stopped",
  interrupted: "interrupted",
  error: "error",
};

/** v1 session status to the personal states. */
export const personalStatusOf = (status: SessionStatus): PersonalThreadStatus =>
  PERSONAL_STATUS[status];

const iso = (value: DateTime.Utc | null | undefined): string | null =>
  value === null || value === undefined ? null : DateTime.formatIso(value);

export const sessionStatusOf = (
  status: OrchestrationV2ShellThreadStatus,
): OrchestrationSession["status"] => {
  switch (status) {
    case "idle":
      return "idle";
    case "queued":
    case "preparing":
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "waiting":
      return "ready";
    case "completed":
      return "ready";
    case "failed":
      return "error";
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return "interrupted";
  }
};

const latestTurnStateOf = (
  status: OrchestrationV2ShellThreadStatus,
): "running" | "interrupted" | "completed" | "error" | null => {
  switch (status) {
    case "queued":
    case "preparing":
    case "starting":
    case "running":
    case "waiting":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return "interrupted";
    case "idle":
      return null;
  }
};

const backgroundLivenessOf = (
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask> | undefined,
): "working" | "monitoring" | null => {
  if (tasks === undefined || tasks.length === 0) return null;
  return tasks.every((task) => task.kind === "monitor") ? "monitoring" : "working";
};

const pendingApprovalOf = (shell: OrchestrationV2ThreadShell): boolean => {
  const request = shell.pendingRuntimeRequest;
  if (request === null) return false;
  return request.kind !== "user_input";
};

const pendingUserInputOf = (shell: OrchestrationV2ThreadShell): boolean =>
  shell.pendingRuntimeRequest?.kind === "user_input";

const sessionOf = (
  shell: OrchestrationV2ThreadShell,
  extras: PersonalShellExtras,
): OrchestrationSession | null => {
  if (shell.latestRunId === null && shell.status === "idle") return null;
  return {
    threadId: shell.id,
    status: sessionStatusOf(shell.status),
    providerName: extras.providerName,
    providerInstanceId: shell.providerInstanceId,
    runtimeMode: shell.runtimeMode,
    activeTurnId: shell.activeRunId === null ? null : TurnId.make(shell.activeRunId),
    lastError: shell.lastError ?? null,
    ...(extras.providerRetry === null ? {} : { providerRetry: extras.providerRetry }),
    updatedAt: DateTime.formatIso(shell.updatedAt),
  };
};

export const toV1ThreadShell = (
  shell: OrchestrationV2ThreadShell,
  extras: PersonalShellExtras,
): OrchestrationThreadShell => {
  const session = sessionOf(shell, extras);
  const latestTurnState = latestTurnStateOf(shell.status);
  const latestTurn =
    shell.latestRunId === null || latestTurnState === null
      ? null
      : {
          turnId: TurnId.make(shell.latestRunId),
          state: latestTurnState,
          requestedAt: DateTime.formatIso(shell.latestRunRequestedAt ?? shell.updatedAt),
          startedAt: iso(shell.latestRunStartedAt),
          completedAt: iso(shell.latestRunCompletedAt),
          assistantMessageId: null,
        };
  return {
    id: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    modelSelection: shell.modelSelection,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    branch: shell.branch,
    worktreePath: shell.worktreePath,
    ...(shell.linkedPullRequest === undefined
      ? {}
      : { linkedPullRequest: shell.linkedPullRequest }),
    pullRequests: shell.pullRequests ?? [],
    ...(shell.branchPullRequest === undefined
      ? {}
      : { branchPullRequest: shell.branchPullRequest }),
    latestTurn,
    createdAt: DateTime.formatIso(shell.createdAt),
    updatedAt: DateTime.formatIso(shell.updatedAt),
    archivedAt: iso(shell.archivedAt),
    settledOverride: shell.settledOverride,
    settledAt: iso(shell.settledAt),
    ...(shell.unsettledAt === undefined ? {} : { unsettledAt: iso(shell.unsettledAt) }),
    ...(shell.snoozedUntil === undefined ? {} : { snoozedUntil: iso(shell.snoozedUntil) }),
    ...(shell.snoozedAt === undefined ? {} : { snoozedAt: iso(shell.snoozedAt) }),
    ...(shell.pinnedAt === undefined ? {} : { pinnedAt: iso(shell.pinnedAt) }),
    ...(shell.pinOrderKey === undefined ? {} : { pinOrderKey: shell.pinOrderKey }),
    ...(shell.activeOrderKey === undefined ? {} : { activeOrderKey: shell.activeOrderKey }),
    ...(shell.autoSettleDisabledAt === undefined
      ? {}
      : { autoSettleDisabledAt: iso(shell.autoSettleDisabledAt) }),
    ...(shell.titleRegeneration === undefined
      ? {}
      : {
          titleRegeneration:
            shell.titleRegeneration === null
              ? null
              : {
                  requestId: shell.titleRegeneration.requestId,
                  startedAt: DateTime.formatIso(shell.titleRegeneration.startedAt),
                },
        }),
    titleState: extras.titleState,
    session,
    latestUserMessageAt: iso(shell.latestUserMessageAt),
    hasPendingApprovals: pendingApprovalOf(shell),
    hasPendingUserInput: pendingUserInputOf(shell),
    hasActionableProposedPlan: shell.hasActionableProposedPlan,
    backgroundLiveness: backgroundLivenessOf(shell.pendingBackgroundTasks),
  };
};
