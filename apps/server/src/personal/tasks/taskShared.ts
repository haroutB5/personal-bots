import * as DateTime from "effect/DateTime";

import {
  ComposerContextId,
  PERSONAL_TASK_MESSAGE_CONTEXT_KIND,
  type OrchestrationMessageContext,
  type OrchestrationSession,
  type PersonalTask,
  type PersonalTaskAttempt,
  type PersonalTaskMessageMarker,
  type ThreadId,
} from "@t3tools/contracts";

import { personalTaskMessageId } from "../personalThreadTitles.ts";

/** What the task service's parts share: its status types, timings and message ids. */

export const PERSONAL_TASKS_DEFAULT_MAX_DEPTH = 2;
export const PERSONAL_TASKS_DEFAULT_MAX_CHILDREN = 4;
export const LEASE_MINUTES = 2;
/**
 * How long after an attempt settles its thread still counts as task-driven.
 * Only has to outlast the gap between two reactors of the same domain event,
 * so seconds are plenty; it is deliberately short so an ordinary chat turn
 * right after a task finishes still notifies.
 */
export const PERSONAL_TASK_TURN_OWNERSHIP_MS = 30_000;
export const SWEEP_INTERVAL = "30 seconds";

export type Changed = Array<PersonalTask>;

export type AttemptOutcome =
  | { readonly kind: "completed"; readonly summary: string }
  | { readonly kind: "interrupted"; readonly message: string | null }
  | {
      readonly kind: "failed";
      readonly category: "rate_limited" | "provider_error" | "dispatch_failed";
      readonly message: string | null;
      /** A reset the provider reported; replaces the 1/5/15 min backoff. */
      readonly availableAt?: DateTime.Utc;
      /** The usage limit the provider reported, for the bot's model fallback. */
      readonly limit?: {
        readonly provider: string;
        readonly instanceId?: string | undefined;
        readonly reason?: string | undefined;
        readonly retryAt?: string | undefined;
      };
    };

export type WorkItem =
  | { readonly type: "pump" }
  | { readonly type: "sweep" }
  | {
      readonly type: "session";
      readonly threadId: ThreadId;
      readonly session: OrchestrationSession;
    }
  | { readonly type: "settle"; readonly threadId: ThreadId }
  | { readonly type: "resume"; readonly threadId: ThreadId };

export const minutesFrom = (now: DateTime.Utc, minutes: number) => DateTime.add(now, { minutes });

/** The user message that starts an attempt's turn; deterministic so a re-dispatch dedupes. */
export const attemptMessageId = (attempt: PersonalTaskAttempt) =>
  personalTaskMessageId(attempt.taskId, attempt.attempt);

/**
 * The message context that marks a task turn as server-authored. The record is
 * never referenced from the text, so `projectComposerContextForProvider` drops
 * it and the provider prompt is unchanged.
 */
export const personalTaskMessageContext = (
  marker: PersonalTaskMessageMarker,
): OrchestrationMessageContext => ({
  version: 1,
  records: [
    {
      version: 1,
      contextId: ComposerContextId.make(PERSONAL_TASK_MESSAGE_CONTEXT_KIND),
      label: "Task turn",
      kind: PERSONAL_TASK_MESSAGE_CONTEXT_KIND,
      payload: marker,
    },
  ],
});
