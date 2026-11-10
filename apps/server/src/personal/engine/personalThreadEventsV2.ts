/**
 * v2 domain events mapped onto the personal event union.
 *
 * One event becomes zero, one or two personal events. The state carries the
 * previous status so a terminal run reports one turn end, and the first user
 * message of a run reports the turn start once.
 *
 * @module personal/engine/personalThreadEventsV2
 */
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { TurnId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type {
  PersonalSessionView,
  PersonalThreadEvent,
  PersonalThreadStatus,
  PersonalTurnFailure,
} from "./PersonalEngine.ts";
import {
  personalStatusOf,
  sessionStatusOf,
  type PersonalShellExtras,
} from "./PersonalThreadShellV2.ts";

export interface PersonalEventState {
  readonly statusByThread: Map<string, PersonalThreadStatus>;
  readonly driverByThread: Map<string, string>;
  readonly startedMessages: Set<string>;
  readonly endedRuns: Set<string>;
}

export interface PersonalEventContext {
  readonly readShell: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell | null, unknown>;
  readonly readExtras: (threadId: ThreadId) => Effect.Effect<PersonalShellExtras, unknown>;
}

export const makePersonalEventState = (): PersonalEventState => ({
  statusByThread: new Map(),
  driverByThread: new Map(),
  startedMessages: new Set(),
  endedRuns: new Set(),
});

const REMEMBER_LIMIT = 50_000;

const remember = (set: Set<string>, value: string): boolean => {
  if (set.has(value)) return false;
  if (set.size >= REMEMBER_LIMIT) set.clear();
  set.add(value);
  return true;
};

const runStatusToPersonal = (run: OrchestrationV2Run): PersonalThreadStatus =>
  personalStatusOf(sessionStatusOf(run.status));

const shellStatusToPersonal = (shell: OrchestrationV2ThreadShell): PersonalThreadStatus =>
  personalStatusOf(sessionStatusOf(shell.status));

const fallbackView = (
  threadId: ThreadId,
  run: OrchestrationV2Run,
  status: PersonalThreadStatus,
  driver: string | null,
): PersonalSessionView => ({
  threadId,
  status,
  activeTurnId: run.status === "running" || run.status === "waiting" ? TurnId.make(run.id) : null,
  lastError: null,
  providerInstanceId: run.providerInstanceId,
  providerName: driver,
  providerRetry: null,
  updatedAt: DateTime.formatIso(run.requestedAt),
});

const viewOf = (
  threadId: ThreadId,
  shell: OrchestrationV2ThreadShell,
  extras: PersonalShellExtras,
): PersonalSessionView => ({
  threadId,
  status: shellStatusToPersonal(shell),
  activeTurnId: shell.activeRunId === null ? null : TurnId.make(shell.activeRunId),
  lastError: shell.lastError ?? null,
  providerInstanceId: shell.providerInstanceId,
  providerName: extras.providerName,
  providerRetry: extras.providerRetry,
  updatedAt: DateTime.formatIso(shell.updatedAt),
});

const failureOf = (
  shell: OrchestrationV2ThreadShell | null,
  extras: PersonalShellExtras | null,
): PersonalTurnFailure => ({
  message: shell?.lastError ?? null,
  providerRetry:
    extras?.providerRetry === null || extras?.providerRetry === undefined
      ? null
      : {
          kind: extras.providerRetry.kind,
          retryAt: extras.providerRetry.retryAt ?? null,
        },
});

const readSession = (
  threadId: ThreadId,
  context: PersonalEventContext,
): Effect.Effect<{
  shell: OrchestrationV2ThreadShell | null;
  extras: PersonalShellExtras | null;
}> =>
  Effect.gen(function* () {
    const shell = yield* context.readShell(threadId).pipe(Effect.orElseSucceed(() => null));
    if (shell === null) return { shell: null, extras: null };
    const extras = yield* context.readExtras(threadId).pipe(Effect.orElseSucceed(() => null));
    return { shell, extras };
  });

const outcomeOf = (run: OrchestrationV2Run): "Completed" | "Interrupted" | "Failed" =>
  run.status === "completed" ? "Completed" : run.status === "failed" ? "Failed" : "Interrupted";

export const toPersonalEvents = (
  event: OrchestrationV2DomainEvent,
  state: PersonalEventState,
  context: PersonalEventContext,
): Effect.Effect<ReadonlyArray<PersonalThreadEvent>> => {
  if (event.driver !== undefined) {
    state.driverByThread.set(event.threadId, event.driver);
  }
  switch (event.type) {
    case "thread.archived":
      return Effect.succeed([{ _tag: "ThreadArchived", threadId: event.threadId }]);
    case "thread.unarchived":
      return Effect.succeed([{ _tag: "ThreadUnarchived", threadId: event.threadId }]);
    case "thread.deleted":
      return Effect.succeed([{ _tag: "ThreadDeleted", threadId: event.threadId }]);
    case "message.updated": {
      const message = event.payload;
      if (message.role !== "user" && message.role !== "assistant") return Effect.succeed([]);
      const events: Array<PersonalThreadEvent> = [
        {
          _tag: "MessageSent",
          threadId: event.threadId,
          messageId: message.id,
          role: message.role,
          text: message.text,
          streaming: message.streaming,
        },
      ];
      if (
        message.role === "user" &&
        message.runId !== null &&
        remember(state.startedMessages, message.id)
      ) {
        return readSession(event.threadId, context).pipe(
          Effect.map(({ shell }) => [
            {
              _tag: "TurnStartRequested",
              threadId: event.threadId,
              messageId: message.id,
              interactionMode: shell?.interactionMode ?? "default",
            } satisfies PersonalThreadEvent,
            ...events,
          ]),
        );
      }
      return Effect.succeed(events);
    }
    case "run.updated": {
      const run = event.payload;
      const status = runStatusToPersonal(run);
      state.statusByThread.set(event.threadId, status);
      return readSession(event.threadId, context).pipe(
        Effect.map(({ shell, extras }) => {
          const view =
            shell === null
              ? fallbackView(
                  event.threadId,
                  run,
                  status,
                  state.driverByThread.get(event.threadId) ?? null,
                )
              : viewOf(
                  event.threadId,
                  shell,
                  extras ?? {
                    providerName: state.driverByThread.get(event.threadId) ?? null,
                    providerRetry: null,
                    titleState: null,
                  },
                );
          const events: Array<PersonalThreadEvent> = [
            {
              _tag: "StatusChanged",
              threadId: event.threadId,
              status: view.status,
              session: view,
            },
          ];
          const terminal =
            run.status === "completed" ||
            run.status === "failed" ||
            run.status === "interrupted" ||
            run.status === "cancelled" ||
            run.status === "rolled_back";
          if (!terminal || !remember(state.endedRuns, run.id)) return events;
          if (run.status === "interrupted" || run.status === "cancelled") {
            events.push({ _tag: "TurnStopRequested", threadId: event.threadId });
          }
          const outcome = outcomeOf(run);
          events.push({
            _tag: "TurnEnded",
            threadId: event.threadId,
            outcome:
              outcome === "Failed"
                ? { _tag: "Failed", failure: failureOf(shell, extras) }
                : { _tag: outcome },
            session: view,
          });
          return events;
        }),
      );
    }
    case "provider-session.detached":
      return readSession(event.threadId, context).pipe(
        Effect.map(({ shell, extras }) => {
          if (shell === null) return [];
          const view = viewOf(
            event.threadId,
            shell,
            extras ?? {
              providerName: null,
              providerRetry: null,
              titleState: null,
            },
          );
          return [
            {
              _tag: "StatusChanged",
              threadId: event.threadId,
              status: view.status,
              session: view,
            } satisfies PersonalThreadEvent,
          ];
        }),
      );
    case "turn-item.updated": {
      const item = event.payload;
      if (item.status !== "waiting") return Effect.succeed([]);
      if (item.type === "user_input_request") {
        return Effect.succeed([
          {
            _tag: "ActivityAppended",
            threadId: event.threadId,
            activity: {
              id: item.id,
              kind: "user-input.requested",
              payload: { requestId: item.requestId, questions: item.questions },
            },
          },
        ]);
      }
      if (item.type === "approval_request") {
        return Effect.succeed([
          {
            _tag: "ActivityAppended",
            threadId: event.threadId,
            activity: {
              id: item.id,
              kind: "approval.requested",
              payload: {
                requestId: item.requestId,
                kind: item.requestKind,
                ...(item.prompt === undefined ? {} : { prompt: item.prompt }),
                ...(item.reason === undefined ? {} : { reason: item.reason }),
              },
            },
          },
        ]);
      }
      return Effect.succeed([]);
    }
    default:
      return Effect.succeed([]);
  }
};
