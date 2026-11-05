import type {
  EnvironmentId,
  PersonalMemoryKind,
  PersonalMemoryListResult,
  PersonalMemoryRulesUsage,
  PersonalMemoryTidyLogResult,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";
import { useMemo, useRef } from "react";

import type { PersonalClient } from "../client.ts";
import type { EnvironmentQueryView } from "../react/query.ts";

/** How many tidy-up runs the changelog shows. */
export const TIDY_LOG_INPUT = { limit: 10 } as const;

export interface MemoryListFilter {
  readonly kind?: PersonalMemoryKind;
  readonly replaced?: boolean;
  readonly query?: string;
  readonly limit?: number;
}

/**
 * Bumped whenever a command changes memory: every list on screen reloads,
 * whatever its kind, search or page size. Refreshing one fixed input would
 * miss the others.
 */
const memoryListEpoch = Atom.make(0).pipe(Atom.withLabel("personal-memory:list-epoch"));

type EpochRegistry = {
  get: (atom: typeof memoryListEpoch) => number;
  set: (atom: typeof memoryListEpoch, value: number) => void;
};

const refreshMemory = (
  _target: { readonly environmentId: EnvironmentId },
  registry: EpochRegistry,
) => Effect.sync(() => registry.set(memoryListEpoch, registry.get(memoryListEpoch) + 1));

export function createPersonalMemoryClient<R, ER, P>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
  client: PersonalClient<R, ER, P>,
) {
  const personalMemoryList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-memory:list",
    tag: WS_METHODS.personalMemoryList,
    staleTimeMs: 5_000,
    refreshTrigger: () => memoryListEpoch,
  });

  const personalMemoryRulesUsage = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-memory:rules-usage",
    tag: WS_METHODS.personalMemoryRulesUsage,
    staleTimeMs: 10_000,
  });

  const personalMemoryTidyLog = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-memory:tidy-log",
    tag: WS_METHODS.personalMemoryTidyLog,
    staleTimeMs: 10_000,
  });

  const refreshTidyLog = (
    target: { readonly environmentId: EnvironmentId },
    registry: { refresh: (atom: ReturnType<typeof personalMemoryTidyLog>) => void },
  ) =>
    Effect.sync(() =>
      registry.refresh(
        personalMemoryTidyLog({ environmentId: target.environmentId, input: TIDY_LOG_INPUT }),
      ),
    );

  const personalMemoryDelete = createEnvironmentRpcCommand(runtime, {
    label: "personal-memory:delete",
    tag: WS_METHODS.personalMemoryDelete,
    onSuccess: refreshMemory,
  });

  const personalMemoryFeedback = createEnvironmentRpcCommand(runtime, {
    label: "personal-memory:feedback",
    tag: WS_METHODS.personalMemoryFeedback,
    onSuccess: refreshMemory,
  });

  const personalMemoryDeleteMany = createEnvironmentRpcCommand(runtime, {
    label: "personal-memory:delete-many",
    tag: WS_METHODS.personalMemoryDeleteMany,
    onSuccess: refreshMemory,
  });

  const personalMemoryRestore = createEnvironmentRpcCommand(runtime, {
    label: "personal-memory:restore",
    tag: WS_METHODS.personalMemoryRestore,
    onSuccess: refreshMemory,
  });

  const personalMemoryTidySetMode = createEnvironmentRpcCommand(runtime, {
    label: "personal-memory:tidy-set-mode",
    tag: WS_METHODS.personalMemoryTidySetMode,
    onSuccess: refreshTidyLog,
  });

  const personalMemoryTidyRun = createEnvironmentRpcCommand(runtime, {
    label: "personal-memory:tidy-run",
    tag: WS_METHODS.personalMemoryTidyRun,
    onSettled: (target, registry) =>
      Effect.andThen(
        refreshTidyLog(target, registry),
        target.input.dryRun === false ? refreshMemory(target, registry) : Effect.void,
      ),
  });

  const personalMemoryTidyDecide = createEnvironmentRpcCommand(runtime, {
    label: "personal-memory:tidy-decide",
    tag: WS_METHODS.personalMemoryTidyDecide,
    onSuccess: (target, registry) =>
      Effect.andThen(
        refreshTidyLog(target, registry),
        target.input.approve ? refreshMemory(target, registry) : Effect.void,
      ),
  });

  const personalMemoryTidyUndo = createEnvironmentRpcCommand(runtime, {
    label: "personal-memory:tidy-undo",
    tag: WS_METHODS.personalMemoryTidyUndo,
    onSuccess: (target, registry) =>
      Effect.andThen(refreshTidyLog(target, registry), refreshMemory(target, registry)),
  });

  function usePersonalMemoryList(
    environmentId: EnvironmentId | null,
    filter: MemoryListFilter,
  ): EnvironmentQueryView<PersonalMemoryListResult> {
    const { kind, replaced, query, limit } = filter;
    const atom = useMemo(
      () =>
        environmentId === null
          ? null
          : personalMemoryList({
              environmentId,
              input: {
                ...(kind === undefined ? {} : { kind }),
                ...(replaced === true ? { status: "superseded" as const } : {}),
                ...(query === undefined || query === "" ? {} : { query }),
                ...(limit === undefined ? {} : { limit }),
              },
            }),
      [environmentId, kind, replaced, query, limit],
    );
    const view = client.useEnvironmentQuery(atom);
    const last = useRef<typeof view.data>(null);
    if (view.data !== null) last.current = view.data;
    return { ...view, data: view.data ?? last.current };
  }

  function usePersonalMemoryRulesUsage(
    environmentId: EnvironmentId | null,
  ): EnvironmentQueryView<PersonalMemoryRulesUsage> {
    const atom = useMemo(
      () =>
        environmentId === null ? null : personalMemoryRulesUsage({ environmentId, input: {} }),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  function usePersonalMemoryTidyLog(
    environmentId: EnvironmentId | null,
  ): EnvironmentQueryView<PersonalMemoryTidyLogResult> {
    const atom = useMemo(
      () =>
        environmentId === null
          ? null
          : personalMemoryTidyLog({ environmentId, input: TIDY_LOG_INPUT }),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  return {
    memoryListEpoch,
    personalMemoryList,
    personalMemoryRulesUsage,
    personalMemoryTidyLog,
    personalMemoryDelete,
    personalMemoryFeedback,
    personalMemoryDeleteMany,
    personalMemoryRestore,
    personalMemoryTidySetMode,
    personalMemoryTidyRun,
    personalMemoryTidyDecide,
    personalMemoryTidyUndo,
    usePersonalMemoryList,
    usePersonalMemoryRulesUsage,
    usePersonalMemoryTidyLog,
  };
}

export type PersonalMemoryClient = ReturnType<typeof createPersonalMemoryClient>;
