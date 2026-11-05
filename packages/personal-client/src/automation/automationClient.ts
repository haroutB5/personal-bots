import type {
  EnvironmentId,
  PersonalRoutineListResult,
  PersonalTask,
  PersonalTaskDetail,
  PersonalTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { useEnvironmentQuery, type EnvironmentQueryView } from "../react/query.ts";
import { foldPersonalTasksFeed } from "./taskFeed.ts";

/**
 * Tasks and routines: the live task feed, task detail and history, and every
 * routine mutation the Tasks screens run. Shared by web and phone so both read
 * the same atoms and refresh the same lists; the caller owns the runtime.
 */
export function createPersonalAutomationClient<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
) {
  const personalTasksFeed = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "personal-tasks:feed",
    tag: WS_METHODS.personalTasksSubscribe,
    transform: foldPersonalTasksFeed,
  });

  const personalTaskDetail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-tasks:get",
    tag: WS_METHODS.personalTasksGet,
    // The live feed moves a running task; the detail refetches on that move.
    staleTimeMs: 2_000,
  });

  /** A task's tree beyond what the feed replays: named tasks and their children. */
  const personalTaskRelated = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-tasks:related",
    tag: WS_METHODS.personalTasksRelated,
    staleTimeMs: 30_000,
  });

  /** Pages of finished tasks, newest first, for "Show older tasks". */
  const personalTaskHistory = createEnvironmentRpcCommand(runtime, {
    label: "personal-tasks:history",
    tag: WS_METHODS.personalTasksHistory,
  });

  const personalRoutinesList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-routines:list",
    tag: WS_METHODS.personalRoutinesList,
    staleTimeMs: 5_000,
    // Next-run times and occurrences move on the server's clock.
    refreshIntervalMs: 30_000,
  });

  type CommandTarget = { readonly environmentId: EnvironmentId };
  type Registry = { refresh: (atom: never) => void };

  /** Every routine command redraws the one list the Tasks screens read. */
  const refreshRoutines = (target: CommandTarget, registry: Registry) =>
    Effect.sync(() =>
      registry.refresh(
        personalRoutinesList({ environmentId: target.environmentId, input: {} }) as never,
      ),
    );

  const personalTaskCancel = createEnvironmentRpcCommand(runtime, {
    label: "personal-tasks:cancel",
    tag: WS_METHODS.personalTasksCancel,
  });

  const personalTaskRetry = createEnvironmentRpcCommand(runtime, {
    label: "personal-tasks:retry",
    tag: WS_METHODS.personalTasksRetry,
  });

  const personalRoutineCreate = createEnvironmentRpcCommand(runtime, {
    label: "personal-routines:create",
    tag: WS_METHODS.personalRoutinesCreate,
    onSuccess: refreshRoutines,
  });

  const personalRoutineUpdate = createEnvironmentRpcCommand(runtime, {
    label: "personal-routines:update",
    tag: WS_METHODS.personalRoutinesUpdate,
    onSuccess: refreshRoutines,
  });

  const personalRoutineDelete = createEnvironmentRpcCommand(runtime, {
    label: "personal-routines:delete",
    tag: WS_METHODS.personalRoutinesDelete,
    onSuccess: refreshRoutines,
  });

  const personalRoutinePause = createEnvironmentRpcCommand(runtime, {
    label: "personal-routines:pause",
    tag: WS_METHODS.personalRoutinesPause,
    onSuccess: refreshRoutines,
  });

  const personalRoutineResume = createEnvironmentRpcCommand(runtime, {
    label: "personal-routines:resume",
    tag: WS_METHODS.personalRoutinesResume,
    onSuccess: refreshRoutines,
  });

  const personalRoutinesDeleteMany = createEnvironmentRpcCommand(runtime, {
    label: "personal-routines:delete-many",
    tag: WS_METHODS.personalRoutinesDeleteMany,
    onSuccess: refreshRoutines,
  });

  const personalRoutinesSetEnabledMany = createEnvironmentRpcCommand(runtime, {
    label: "personal-routines:set-enabled-many",
    tag: WS_METHODS.personalRoutinesSetEnabledMany,
    onSuccess: refreshRoutines,
  });

  const personalRoutineRunNow = createEnvironmentRpcCommand(runtime, {
    label: "personal-routines:run-now",
    tag: WS_METHODS.personalRoutinesRunNow,
    onSuccess: refreshRoutines,
  });

  const personalRoutineRegenerateHook = createEnvironmentRpcCommand(runtime, {
    label: "personal-routines:regenerate-hook",
    tag: WS_METHODS.personalRoutinesRegenerateHook,
    onSuccess: refreshRoutines,
  });

  function usePersonalTasks(environmentId: EnvironmentId | null): {
    readonly tasks: ReadonlyMap<string, PersonalTask> | null;
    readonly error: string | null;
  } {
    const atom = useMemo(
      () => (environmentId === null ? null : personalTasksFeed({ environmentId, input: {} })),
      [environmentId],
    );
    const query = useEnvironmentQuery(atom);
    return { tasks: query.data, error: query.error };
  }

  function usePersonalTaskDetail(
    environmentId: EnvironmentId | null,
    taskId: PersonalTaskId,
  ): EnvironmentQueryView<PersonalTaskDetail> {
    const atom = useMemo(
      () =>
        environmentId === null ? null : personalTaskDetail({ environmentId, input: { taskId } }),
      [environmentId, taskId],
    );
    return useEnvironmentQuery(atom);
  }

  /** Summaries of named tasks, with their children. Null input: nothing. */
  function usePersonalRelatedTasks(
    environmentId: EnvironmentId | null,
    input: {
      readonly threadId?: ThreadId;
      readonly taskIds?: ReadonlyArray<PersonalTaskId>;
    } | null,
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

  function usePersonalRoutines(
    environmentId: EnvironmentId | null,
  ): EnvironmentQueryView<PersonalRoutineListResult> {
    const atom = useMemo(
      () => (environmentId === null ? null : personalRoutinesList({ environmentId, input: {} })),
      [environmentId],
    );
    return useEnvironmentQuery(atom);
  }

  return {
    personalTasksFeed,
    personalTaskDetail,
    personalTaskRelated,
    personalTaskHistory,
    personalRoutinesList,
    personalTaskCancel,
    personalTaskRetry,
    personalRoutineCreate,
    personalRoutineUpdate,
    personalRoutineDelete,
    personalRoutinePause,
    personalRoutineResume,
    personalRoutinesDeleteMany,
    personalRoutinesSetEnabledMany,
    personalRoutineRunNow,
    personalRoutineRegenerateHook,
    usePersonalTasks,
    usePersonalTaskDetail,
    usePersonalRelatedTasks,
    usePersonalRoutines,
  };
}

export type PersonalAutomationClient = ReturnType<typeof createPersonalAutomationClient>;
