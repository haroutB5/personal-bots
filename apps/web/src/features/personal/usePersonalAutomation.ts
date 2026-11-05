import type {
  EnvironmentId,
  PersonalMemoryKind,
  PersonalTask,
  PersonalTaskId,
} from "@t3tools/contracts";
import { PersonalMemoryId, WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { createPersonalAutomationClient } from "@hbots/personal-client/automation/automationClient";
import { relatedTasksInBatches } from "@hbots/personal-client/automation/taskFeed";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo, useRef } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";

const automation = createPersonalAutomationClient(connectionAtomRuntime);

export const {
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
} = automation;

export { foldPersonalTasksFeed } from "@hbots/personal-client/automation/taskFeed";

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

/**
 * Bumped whenever a command changes memory: every memory list on screen, each
 * with its own kind, search and size, reloads. (The lists differ in input, so
 * refreshing one fixed input, as the other families do, would miss them.)
 */
export const memoryListEpoch = Atom.make(0).pipe(Atom.withLabel("personal-memory:list-epoch"));

export const personalMemoryList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-memory:list",
  tag: WS_METHODS.personalMemoryList,
  staleTimeMs: 5_000,
  refreshTrigger: () => memoryListEpoch,
});

/** How full the most rules any bot can receive at once are, for the Memory screen's warning card. */
export const personalMemoryRulesUsage = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-memory:rules-usage",
  tag: WS_METHODS.personalMemoryRulesUsage,
  staleTimeMs: 10_000,
});

/**
 * What one assistant turn's memory block held and why (the "Context used"
 * view), read only when the owner opens it. The turn is named by the message
 * that started it.
 */
export const personalMemoryTurnContext = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "personal-memory:turn-context",
    tag: WS_METHODS.personalMemoryTurnContext,
    staleTimeMs: 30_000,
  },
);

/** How many tidy-up runs the Memory screen's changelog shows. */
export const TIDY_LOG_INPUT = { limit: 10 } as const;

/** The nightly memory tidy-up's mode and its recent runs (the changelog). */
export const personalMemoryTidyLog = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-memory:tidy-log",
  tag: WS_METHODS.personalMemoryTidyLog,
  staleTimeMs: 10_000,
});

/**
 * A chat's memory cards: a bot's save or forget that waits for the owner.
 * Polled like the lead-bot change cards, since no subscription exists and a
 * card asked mid-conversation has to surface without reopening the chat.
 */
export const personalMemoryCards = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-memory:cards",
  tag: WS_METHODS.personalMemoryCards,
  staleTimeMs: 3_000,
  refreshIntervalMs: 6_000,
});

export const personalPushSettings = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-push:settings",
  tag: WS_METHODS.personalPushGetSettings,
  staleTimeMs: 10_000,
});

type Registry = { refresh: (atom: never) => void };

type EpochRegistry = {
  get: (atom: typeof memoryListEpoch) => number;
  set: (atom: typeof memoryListEpoch, value: number) => void;
};

const refreshing =
  <A>(family: (target: { environmentId: EnvironmentId; input: {} }) => A) =>
  (target: { readonly environmentId: EnvironmentId }, registry: Registry) =>
    Effect.sync(() =>
      registry.refresh(family({ environmentId: target.environmentId, input: {} }) as never),
    );

const refreshMemory = (
  _target: { readonly environmentId: EnvironmentId },
  registry: EpochRegistry,
) => Effect.sync(() => registry.set(memoryListEpoch, registry.get(memoryListEpoch) + 1));
const refreshPush = refreshing(personalPushSettings);

/** Restore moves an entry from the replaced list back to the current one: both lists change. */
const refreshMemoryAndReplaced = refreshMemory;

const refreshTidyLog = (target: { readonly environmentId: EnvironmentId }, registry: Registry) =>
  Effect.sync(() =>
    registry.refresh(
      personalMemoryTidyLog({
        environmentId: target.environmentId,
        input: TIDY_LOG_INPUT,
      }) as never,
    ),
  );

export const personalMemoryDelete = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-memory:delete",
  tag: WS_METHODS.personalMemoryDelete,
  onSuccess: refreshMemory,
});

/** Marks a note or task summary outdated or not relevant (ranked lower, never deleted), or clears it. */
export const personalMemoryFeedback = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-memory:feedback",
  tag: WS_METHODS.personalMemoryFeedback,
  onSuccess: refreshMemory,
});

export const personalMemoryDeleteMany = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-memory:delete-many",
  tag: WS_METHODS.personalMemoryDeleteMany,
  onSuccess: refreshMemory,
});

/** Brings a replaced entry back: bots receive it again. */
export const personalMemoryRestore = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-memory:restore",
  tag: WS_METHODS.personalMemoryRestore,
  onSuccess: refreshMemoryAndReplaced,
});

/** One memory entry, current or archived: whether a note line's Undo was already used. */
export const personalMemoryEntry = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-memory:get",
  tag: WS_METHODS.personalMemoryGet,
  staleTimeMs: 30_000,
});

export function usePersonalMemoryEntry(environmentId: EnvironmentId | null, memoryId: string) {
  const atom = useMemo(
    () =>
      environmentId === null
        ? null
        : personalMemoryEntry({
            environmentId,
            input: { memoryId: PersonalMemoryId.make(memoryId) },
          }),
    [environmentId, memoryId],
  );
  return useEnvironmentQuery(atom);
}

/** Undo on a "Saved a note" chat line: archives the note, bringing back what it replaced. */
export const personalMemoryUndoNote = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-memory:undo-note",
  tag: WS_METHODS.personalMemoryUndoNote,
  onSuccess: refreshMemoryAndReplaced,
});

export const personalMemoryTidySetMode = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-memory:tidy-set-mode",
  tag: WS_METHODS.personalMemoryTidySetMode,
  onSuccess: refreshTidyLog,
});

/** Runs the tidy-up now (a preview when dryRun); it can take a minute. A real run changes both lists. */
export const personalMemoryTidyRun = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-memory:tidy-run",
  tag: WS_METHODS.personalMemoryTidyRun,
  onSettled: (target, registry) =>
    Effect.andThen(
      refreshTidyLog(target, registry),
      target.input.dryRun === false ? refreshMemoryAndReplaced(target, registry) : Effect.void,
    ),
});

/** The owner's answer to a pending tidy-up change; an approval changes both memory lists. */
export const personalMemoryTidyDecide = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-memory:tidy-decide",
  tag: WS_METHODS.personalMemoryTidyDecide,
  onSuccess: (target, registry) =>
    Effect.andThen(
      refreshTidyLog(target, registry),
      target.input.approve ? refreshMemoryAndReplaced(target, registry) : Effect.void,
    ),
});

/** Takes back a change made on its own: both memory lists and the log change. */
export const personalMemoryTidyUndo = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-memory:tidy-undo",
  tag: WS_METHODS.personalMemoryTidyUndo,
  onSuccess: (target, registry) =>
    Effect.andThen(refreshTidyLog(target, registry), refreshMemoryAndReplaced(target, registry)),
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

export { personalPushAckInApp, personalPushInAppFeed } from "./usePersonalBots";

/** What the Memory screen asks for: one kind, or the Replaced entries, optionally searched and sized. */
export interface MemoryListFilter {
  readonly kind?: PersonalMemoryKind;
  /** The Replaced list (kept for Restore) instead of the current entries. */
  readonly replaced?: boolean;
  readonly query?: string;
  readonly limit?: number;
}

/**
 * One list of the Memory screen. The search runs on the server over every
 * entry, and the list keeps showing the last answer while a new one loads, so
 * typing or "Show more" never blanks the screen.
 */
export function usePersonalMemoryList(
  environmentId: EnvironmentId | null,
  filter: MemoryListFilter,
) {
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
  const view = useEnvironmentQuery(atom);
  const last = useRef<typeof view.data>(null);
  if (view.data !== null) last.current = view.data;
  return { ...view, data: view.data ?? last.current };
}

/** One turn's memory, fetched only while `turn` is given (the panel is open). */
export function usePersonalMemoryTurnContext(
  environmentId: EnvironmentId | null,
  turn: { readonly threadId: string; readonly messageId: string } | null,
) {
  const threadId = turn?.threadId ?? null;
  const messageId = turn?.messageId ?? null;
  const atom = useMemo(
    () =>
      environmentId === null || threadId === null || messageId === null
        ? null
        : personalMemoryTurnContext({ environmentId, input: { threadId, messageId } }),
    [environmentId, threadId, messageId],
  );
  return useEnvironmentQuery(atom);
}

export function usePersonalMemoryRulesUsage(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () => (environmentId === null ? null : personalMemoryRulesUsage({ environmentId, input: {} })),
    [environmentId],
  );
  return useEnvironmentQuery(atom);
}

export function usePersonalMemoryTidyLog(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () =>
      environmentId === null
        ? null
        : personalMemoryTidyLog({ environmentId, input: TIDY_LOG_INPUT }),
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
