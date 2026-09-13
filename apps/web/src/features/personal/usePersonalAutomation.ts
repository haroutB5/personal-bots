import type { EnvironmentId, PersonalTask, PersonalTaskId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";

/**
 * Every personal task, kept current by `personalTasks.subscribe` (replay of
 * all tasks as upserts, then live upserts). Emits the whole map each time.
 */
export const personalTasksFeed = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "personal-tasks:feed",
  tag: WS_METHODS.personalTasksSubscribe,
  transform: (stream) =>
    stream.pipe(
      Stream.scan(
        new Map<string, PersonalTask>() as ReadonlyMap<string, PersonalTask>,
        (tasks, event) => new Map(tasks).set(event.task.taskId, event.task),
      ),
    ),
});

export const personalTaskDetail = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-tasks:get",
  tag: WS_METHODS.personalTasksGet,
  staleTimeMs: 2_000,
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

export function usePersonalTasks(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () => (environmentId === null ? null : personalTasksFeed({ environmentId, input: {} })),
    [environmentId],
  );
  const query = useEnvironmentQuery(atom);
  return { tasks: query.data, error: query.error };
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
