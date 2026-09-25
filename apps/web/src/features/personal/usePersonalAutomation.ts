import type {
  EnvironmentId,
  PersonalPushInAppNotification,
  PersonalTask,
  PersonalTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { relatedTasksInBatches } from "./relatedTaskBatches";

/**
 * Unfinished tasks and the newest finished ones, kept current by
 * `personalTasks.subscribe` (replay as upserts, then live upserts). Emits the
 * whole map each time. Entries are summaries (`detailOmitted`): no objective
 * and only a result preview. Older finished tasks come from
 * `usePersonalRelatedTasks` and `personalTaskHistory`; full text from
 * `usePersonalTaskDetail`.
 */
export const personalTasksFeed = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "personal-tasks:feed",
  tag: WS_METHODS.personalTasksSubscribe,
  transform: (stream) =>
    stream.pipe(
      // The replay arrives as one event per task; folding it per event would
      // copy the map n times (O(n^2)) and re-render every consumer n times.
      // Chunks bound that to one copy per batch while live upserts still
      // land within 50ms.
      Stream.groupedWithin(256, "50 millis"),
      Stream.scan(
        new Map<string, PersonalTask>() as ReadonlyMap<string, PersonalTask>,
        (tasks, events) => {
          const next = new Map(tasks);
          for (const event of events) next.set(event.task.taskId, event.task);
          return next;
        },
      ),
    ),
});

export const personalTaskDetail = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-tasks:get",
  tag: WS_METHODS.personalTasksGet,
  staleTimeMs: 2_000,
});

/** A thread's tasks, named tasks and their children, beyond what the feed replays. */
export const personalTaskRelated = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-tasks:related",
  tag: WS_METHODS.personalTasksRelated,
  staleTimeMs: 30_000,
});

/** Pages of finished tasks, newest first, for "Show older tasks". */
export const personalTaskHistory = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-tasks:history",
  tag: WS_METHODS.personalTasksHistory,
});

export const personalRoutinesList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-routines:list",
  tag: WS_METHODS.personalRoutinesList,
  staleTimeMs: 5_000,
  // Next-run times and occurrences move on the server's clock.
  refreshIntervalMs: 30_000,
});

export const personalMemoryList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-memory:list",
  tag: WS_METHODS.personalMemoryList,
  staleTimeMs: 5_000,
});

export const personalPushSettings = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-push:settings",
  tag: WS_METHODS.personalPushGetSettings,
  staleTimeMs: 10_000,
});

type Registry = { refresh: (atom: never) => void };

const refreshing =
  <A>(family: (target: { environmentId: EnvironmentId; input: {} }) => A) =>
  (target: { readonly environmentId: EnvironmentId }, registry: Registry) =>
    Effect.sync(() =>
      registry.refresh(family({ environmentId: target.environmentId, input: {} }) as never),
    );

const refreshRoutines = refreshing(personalRoutinesList);
const refreshMemory = refreshing(personalMemoryList);
const refreshPush = refreshing(personalPushSettings);

export const personalTaskCancel = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-tasks:cancel",
  tag: WS_METHODS.personalTasksCancel,
});

export const personalTaskRetry = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-tasks:retry",
  tag: WS_METHODS.personalTasksRetry,
});

export const personalRoutineCreate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-routines:create",
  tag: WS_METHODS.personalRoutinesCreate,
  onSuccess: refreshRoutines,
});

export const personalRoutineUpdate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-routines:update",
  tag: WS_METHODS.personalRoutinesUpdate,
  onSuccess: refreshRoutines,
});

export const personalRoutineDelete = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-routines:delete",
  tag: WS_METHODS.personalRoutinesDelete,
  onSuccess: refreshRoutines,
});

export const personalRoutinePause = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-routines:pause",
  tag: WS_METHODS.personalRoutinesPause,
  onSuccess: refreshRoutines,
});

export const personalRoutineResume = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-routines:resume",
  tag: WS_METHODS.personalRoutinesResume,
  onSuccess: refreshRoutines,
});

export const personalRoutineRunNow = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-routines:run-now",
  tag: WS_METHODS.personalRoutinesRunNow,
  onSuccess: refreshRoutines,
});

export const personalRoutineRegenerateHook = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-routines:regenerate-hook",
  tag: WS_METHODS.personalRoutinesRegenerateHook,
  onSuccess: refreshRoutines,
});

export const personalMemoryDelete = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-memory:delete",
  tag: WS_METHODS.personalMemoryDelete,
  onSuccess: refreshMemory,
});

export const personalPushSubscribe = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-push:subscribe",
  tag: WS_METHODS.personalPushSubscribe,
  onSuccess: refreshPush,
});

export const personalPushUnsubscribe = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-push:unsubscribe",
  tag: WS_METHODS.personalPushUnsubscribe,
  onSuccess: refreshPush,
});

export const personalPushTest = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-push:test",
  tag: WS_METHODS.personalPushTest,
  onSuccess: refreshPush,
});

export const personalPushSetPreferences = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-push:set-preferences",
  tag: WS_METHODS.personalPushSetPreferences,
  onSuccess: refreshPush,
});

/** Presence only: it changes nothing the UI reads, so it refreshes nothing. */
/** Opening a bot chat starts its session on the server ahead of the first send. */
export const personalBotsPrewarmThread = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-bots:prewarm-thread",
  tag: WS_METHODS.personalBotsPrewarmThread,
});

export const personalPushReportViewing = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-push:report-viewing",
  tag: WS_METHODS.personalPushReportViewing,
});

/** Presence only: "the app is on screen" (see InAppNotifications). */
export const personalPushReportForeground = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-push:report-foreground",
  tag: WS_METHODS.personalPushReportForeground,
});

export const personalPushAckInApp = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-push:ack-in-app",
  tag: WS_METHODS.personalPushAckInApp,
});

/** How many recent in-app notifications the feed keeps; the banner shows the newest. */
export const IN_APP_FEED_KEEP = 5;

/**
 * In-app notifications for this connection, newest last. A short list rather
 * than only the latest, so two arriving in one render are both seen (and
 * acknowledged) by id.
 */
export const personalPushInAppFeed = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "personal-push:in-app",
    tag: WS_METHODS.personalPushInApp,
    transform: (stream) =>
      stream.pipe(
        Stream.scan([] as ReadonlyArray<PersonalPushInAppNotification>, (recent, notification) =>
          [...recent, notification].slice(-IN_APP_FEED_KEEP),
        ),
      ),
  },
);

export function usePersonalTasks(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () => (environmentId === null ? null : personalTasksFeed({ environmentId, input: {} })),
    [environmentId],
  );
  const query = useEnvironmentQuery(atom);
  return { tasks: query.data, error: query.error };
}

/** Summaries of a chat's tasks or of named tasks, with their children. Null input: nothing. */
export function usePersonalRelatedTasks(
  environmentId: EnvironmentId | null,
  input: { readonly threadId?: ThreadId; readonly taskIds?: ReadonlyArray<PersonalTaskId> } | null,
): ReadonlyArray<PersonalTask> | null {
  const key = input === null ? null : JSON.stringify(input);
  const atom = useMemo(
    () =>
      environmentId === null || key === null
        ? null
        : personalTaskRelated({ environmentId, input: JSON.parse(key) as typeof input & {} }),
    [environmentId, key],
  );
  return useEnvironmentQuery(atom).data?.tasks ?? null;
}

const NO_TASKS_ATOM = Atom.make<ReadonlyArray<PersonalTask> | null>(null);

/**
 * `usePersonalRelatedTasks` for a list of task ids of any length: one related
 * request per 100 ids, since the server drops ids past its cap.
 */
export function usePersonalTasksByIds(
  environmentId: EnvironmentId | null,
  taskIds: ReadonlyArray<PersonalTaskId>,
): ReadonlyArray<PersonalTask> | null {
  const key = JSON.stringify(taskIds);
  const atom = useMemo(() => {
    const ids = JSON.parse(key) as ReadonlyArray<PersonalTaskId>;
    if (environmentId === null || ids.length === 0) return NO_TASKS_ATOM;
    return Atom.make((get) =>
      relatedTasksInBatches(ids, (batch) => {
        const result = get(personalTaskRelated({ environmentId, input: { taskIds: batch } }));
        return Option.getOrNull(AsyncResult.value(result))?.tasks ?? null;
      }),
    );
  }, [environmentId, key]);
  return useAtomValue(atom);
}

export function usePersonalTaskDetail(environmentId: EnvironmentId | null, taskId: PersonalTaskId) {
  const atom = useMemo(
    () =>
      environmentId === null ? null : personalTaskDetail({ environmentId, input: { taskId } }),
    [environmentId, taskId],
  );
  return useEnvironmentQuery(atom);
}

export function usePersonalRoutines(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () => (environmentId === null ? null : personalRoutinesList({ environmentId, input: {} })),
    [environmentId],
  );
  return useEnvironmentQuery(atom);
}

export function usePersonalMemory(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () => (environmentId === null ? null : personalMemoryList({ environmentId, input: {} })),
    [environmentId],
  );
  return useEnvironmentQuery(atom);
}

export function usePersonalPushSettings(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () => (environmentId === null ? null : personalPushSettings({ environmentId, input: {} })),
    [environmentId],
  );
  return useEnvironmentQuery(atom);
}
