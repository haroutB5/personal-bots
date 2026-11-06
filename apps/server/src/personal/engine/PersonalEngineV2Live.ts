/**
 * The v2 engine port, stubbed until C1 to C3 fill it in.
 *
 * Every method dies with the same marker. A call that reaches the port before
 * its fill-in is a loud, named failure instead of a silent empty answer.
 *
 * @module personal/engine/PersonalEngineV2Live
 */
import type { OrchestrationSession } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  PersonalEngine,
  type PersonalEngineShape,
  type PersonalSessionView,
  type PersonalThreadStatus,
} from "./PersonalEngine.ts";

const pending = (method: string) => Effect.die(`v2-port pending: PersonalEngine.${method}`);

/** v1 session status to the personal states. */
export const personalStatusOf = (status: OrchestrationSession["status"]): PersonalThreadStatus => {
  switch (status) {
    case "idle":
      return "idle";
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "ready":
      return "waiting";
    case "stopped":
      return "stopped";
    case "interrupted":
      return "interrupted";
    case "error":
      return "error";
  }
};

/** The session as subscribers read it. One shape for every event that carries one. */
export const toPersonalSessionView = (session: OrchestrationSession): PersonalSessionView => ({
  threadId: session.threadId,
  status: personalStatusOf(session.status),
  activeTurnId: session.activeTurnId,
  lastError: session.lastError,
  providerInstanceId: session.providerInstanceId ?? null,
  providerName: session.providerName,
  providerRetry:
    session.providerRetry === undefined
      ? null
      : {
          kind: session.providerRetry.kind,
          provider: session.providerRetry.provider,
          observedAt: session.providerRetry.observedAt,
          ...(session.providerRetry.retryAt === undefined
            ? {}
            : { retryAt: session.providerRetry.retryAt }),
          ...(session.providerRetry.attempt === undefined
            ? {}
            : { attempt: session.providerRetry.attempt }),
          ...(session.providerRetry.maxAttempts === undefined
            ? {}
            : { maxAttempts: session.providerRetry.maxAttempts }),
          ...(session.providerRetry.reason === undefined
            ? {}
            : { reason: session.providerRetry.reason }),
        },
  updatedAt: session.updatedAt,
});

const shape: PersonalEngineShape = {
  createProject: () => pending("createProject"),
  createThread: () => pending("createThread"),
  send: () => pending("send"),
  continueTurn: () => pending("continueTurn"),
  setProviderRetry: () => pending("setProviderRetry"),
  interrupt: () => pending("interrupt"),
  stop: () => pending("stop"),
  archive: () => pending("archive"),
  deleteThread: () => pending("deleteThread"),
  updateMeta: () => pending("updateMeta"),
  renameThreadIfUnchanged: () => pending("renameThreadIfUnchanged"),
  postNotice: () => pending("postNotice"),
  appendNotice: () => pending("appendNotice"),
  completeNotice: () => pending("completeNotice"),
  postUserMessage: () => pending("postUserMessage"),
  getThread: () => pending("getThread"),
  getProject: () => pending("getProject"),
  listProjects: () => pending("listProjects"),
  latestAssistantMessage: () => pending("latestAssistantMessage"),
  latestUserMessage: () => pending("latestUserMessage"),
  messageById: () => pending("messageById"),
  messagesByIds: () => pending("messagesByIds"),
  listMessages: () => pending("listMessages"),
  latestContextTokens: () => pending("latestContextTokens"),
  compactedSince: () => pending("compactedSince"),
  threadUsedWeb: () => pending("threadUsedWeb"),
  toolStepsSince: () => pending("toolStepsSince"),
  activitiesByIds: () => pending("activitiesByIds"),
  workingSnapshot: () => pending("workingSnapshot"),
  liveTaskIds: () => pending("liveTaskIds"),
  shellSnapshot: () => pending("shellSnapshot"),
  events: Stream.die("v2-port pending: PersonalEngine.events"),
};

export const PersonalEngineV2Live = Layer.succeed(PersonalEngine, shape);
