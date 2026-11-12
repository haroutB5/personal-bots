import type {
  EnvironmentId,
  PersonalBotsListResult,
  PersonalBotId,
  PersonalBotTokenUsageResult,
  PersonalBotRestoreResult,
  PersonalFilesListResult,
  PersonalConnectionApprovalListResult,
  PersonalLeadBotChangeListResult,
  PersonalLoginRequest,
  PersonalMemoryCardsResult,
  PersonalMemoryRulesUsage,
  PersonalMemoryTurnContext,
  PersonalProfile,
  PersonalPushInAppNotification,
  PersonalRemovedBotsListResult,
  PersonalRoutineListResult,
  PersonalSecretsListPendingResult,
  PersonalTask,
  PersonalTaskDetail,
  PersonalTaskListResult,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { PersonalClient } from "../client.ts";
import { commandFailureMessage } from "./commandFeedback.ts";
import { PERSONAL_TIME_ZONE } from "../conversation/greeting.ts";
import { perfOptimizationOn } from "../perf/perfFlags.ts";
import type { EnvironmentQueryView } from "../react/query.ts";
import { foldPersonalTasksFeed } from "../tasks/feed.ts";
import { foldBotShellStream, type BotShellMap } from "./shellStream.ts";

/**
 * Builds the bots list, its profile and file queries, every mutation the
 * personal screens run, and the hooks they read. The app owns the connection
 * runtime and the ports, so the package owns no web singleton and no
 * environment selection.
 */
export type RestoreOutcome =
  | { readonly status: "restored"; readonly result: PersonalBotRestoreResult }
  | { readonly status: "failed"; readonly message: string };

export function createPersonalBotsClient<R, ER, P>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  client: PersonalClient<R, ER, P>,
) {
  /** Shared key for the normal list and all of its mutation refreshes. */
  const personalBotsListInput = () =>
    perfOptimizationOn(client.ports.kv, "archive-links") ? { omitArchived: true } : {};

  /** Bots, bot-thread links and the personal project id for one environment. */
  const personalBotsList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-bots:list",
    tag: WS_METHODS.personalBotsList,
    staleTimeMs: 10_000,
    idleTtlMs: 5 * 60_000,
  });

  /** Enabled and paused routines, for the next run line on a bot row. */
  const personalRoutinesList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-routines:list",
    tag: WS_METHODS.personalRoutinesList,
    staleTimeMs: 10_000,
    idleTtlMs: 5 * 60_000,
  });

  /**
   * Bots a team lead removed (soft delete: chats, memory and settings kept).
   * Owner only. Nothing pushes a removal, so the list is short-lived and the
   * screen refreshes it on mount.
   */
  const personalRemovedBotsList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-bots:removed",
    tag: WS_METHODS.personalBotsListRemoved,
    staleTimeMs: 10_000,
    idleTtlMs: 5 * 60_000,
  });

  /** How many recent in-app notifications the feed keeps; the banner shows the newest. */
  const IN_APP_FEED_KEEP = 5;

  /**
   * In-app notifications for this connection, newest last. The empty list goes
   * first so a connection with no notification yet still produces a value.
   */
  const personalPushInAppFeed = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "personal-push:in-app",
    tag: WS_METHODS.personalPushInApp,
    transform: (stream) =>
      stream.pipe(
        Stream.scan(
          () => [] as ReadonlyArray<PersonalPushInAppNotification>,
          (recent, notification) => [...recent, notification].slice(-IN_APP_FEED_KEEP),
        ),
        Stream.prepend([[] as ReadonlyArray<PersonalPushInAppNotification>]),
      ),
  });

  const personalPushAckInApp = createEnvironmentRpcCommand(runtime, {
    label: "personal-push:ack-in-app",
    tag: WS_METHODS.personalPushAckInApp,
  });

  const personalPushReportViewing = createEnvironmentRpcCommand(runtime, {
    label: "personal-push:report-viewing",
    tag: WS_METHODS.personalPushReportViewing,
  });

  /** Presence only: "the app is on screen". */
  const personalPushReportForeground = createEnvironmentRpcCommand(runtime, {
    label: "personal-push:report-foreground",
    tag: WS_METHODS.personalPushReportForeground,
  });

  /** Spends one banked reset credit on a provider, after the confirm sheet. */
  const providerConsumeResetCredit = createEnvironmentRpcCommand(runtime, {
    label: "usage:consume-reset-credit",
    tag: WS_METHODS.providerConsumeResetCredit,
  });

  const personalGroupsCreate = createEnvironmentRpcCommand(runtime, {
    label: "personal-groups:create",
    tag: WS_METHODS.personalGroupsCreate,
  });

  const serverRefreshProviders = createEnvironmentRpcCommand(runtime, {
    label: "server:refresh-providers",
    tag: WS_METHODS.serverRefreshProviders,
  });

  /**
   * Every open bot chat's shell, live: one snapshot on subscribe, then
   * upserts and removals. One atom per environment is the shared phone store;
   * every screen reads it through `usePersonalBotShells`.
   */
  const personalBotsShells = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "personal-bots:shells",
    tag: WS_METHODS.personalBotsSubscribeThreadShells,
    transform: foldBotShellStream,
    idleTtlMs: 5 * 60_000,
  });

  /** Latest progress note of each working chat, off the projection. */
  const personalBotsWorkingProgress = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-bots:working-progress",
    tag: WS_METHODS.personalBotsWorkingProgress,
    staleTimeMs: 0,
    idleTtlMs: 60_000,
  });

  /** Greeting display name (empty string = unset). */
  const personalProfile = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-bots:profile",
    tag: WS_METHODS.personalBotsGetProfile,
    staleTimeMs: 60_000,
    idleTtlMs: 10 * 60_000,
  });

  /**
   * Files-tab rows with signed asset URLs. The server's URLs live for an hour,
   * so the list refreshes well inside that while the tab is mounted.
   */
  const personalFilesList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-bots:files",
    tag: WS_METHODS.personalBotsListFiles,
    staleTimeMs: 30_000,
    idleTtlMs: 5 * 60_000,
    refreshIntervalMs: 20 * 60_000,
  });

  /**
   * Tokens used per bot over Today, 7 days and 30 days, for the Team screen. No
   * `refreshIntervalMs` on purpose: the atom's timer would outlive the card for
   * the whole idle retention and ask the server (which starts a scan) with
   * nobody looking. The mounted card refreshes it (`useTokenUsageRefresh`).
   */
  const personalBotsTokenUsage = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-bots:token-usage",
    tag: WS_METHODS.personalBotsTokenUsage,
    staleTimeMs: 60_000,
    idleTtlMs: 10 * 60_000,
  });

  const refreshBotsList = (
    target: { readonly environmentId: EnvironmentId },
    registry: { refresh: (atom: ReturnType<typeof personalBotsList>) => void },
  ) =>
    Effect.sync(() =>
      registry.refresh(
        personalBotsList({ environmentId: target.environmentId, input: personalBotsListInput() }),
      ),
    );

  const refreshFilesList = (
    target: { readonly environmentId: EnvironmentId },
    registry: { refresh: (atom: ReturnType<typeof personalFilesList>) => void },
  ) =>
    Effect.sync(() =>
      registry.refresh(personalFilesList({ environmentId: target.environmentId, input: {} })),
    );

  const personalBotCreate = createEnvironmentRpcCommand(runtime, {
    label: "personal-bots:create",
    tag: WS_METHODS.personalBotsCreate,
    onSuccess: refreshBotsList,
  });

  const personalBotUpdate = createEnvironmentRpcCommand(runtime, {
    label: "personal-bots:update",
    tag: WS_METHODS.personalBotsUpdate,
    onSuccess: refreshBotsList,
  });

  /** Saves the pinned strip's order after a drag; the refreshed list carries the new slots. */
  const personalBotsReorderPinned = createEnvironmentRpcCommand(runtime, {
    label: "personal-bots:reorder-pinned",
    tag: WS_METHODS.personalBotsReorderPinned,
    onSuccess: refreshBotsList,
  });

  /** "Check again" on a Settings provider row; the verdict arrives on the provider snapshot. */
  const personalProviderRecheck = createEnvironmentRpcCommand(runtime, {
    label: "personal-bots:recheck-provider",
    tag: WS_METHODS.personalBotsRecheckProvider,
  });

  const personalBotDelete = createEnvironmentRpcCommand(runtime, {
    label: "personal-bots:delete",
    tag: WS_METHODS.personalBotsDelete,
    onSuccess: refreshBotsList,
  });

  /** A restored bot leaves the removed list and joins the main one, so both refresh. */
  const personalBotRestore = createEnvironmentRpcCommand(runtime, {
    label: "personal-bots:restore",
    tag: WS_METHODS.personalBotsRestore,
    onSuccess: (target, registry) =>
      Effect.sync(() => {
        registry.refresh(
          personalRemovedBotsList({ environmentId: target.environmentId, input: {} }),
        );
        registry.refresh(
          personalBotsList({ environmentId: target.environmentId, input: personalBotsListInput() }),
        );
      }),
  });

  const personalBotCreateThread = createEnvironmentRpcCommand(runtime, {
    label: "personal-bots:create-thread",
    tag: WS_METHODS.personalBotsCreateThread,
    onSuccess: refreshBotsList,
  });

  const personalBotArchiveThread = createEnvironmentRpcCommand(runtime, {
    label: "personal-bots:archive-thread",
    tag: WS_METHODS.personalBotsArchiveThread,
    onSuccess: refreshBotsList,
  });

  const personalBotDeleteThread = createEnvironmentRpcCommand(runtime, {
    label: "personal-bots:delete-thread",
    tag: WS_METHODS.personalBotsDeleteThread,
    onSuccess: refreshBotsList,
  });

  // Bulk forms of the two above: one request and one list refresh for the whole
  // selection, each chat going through the same server path as a single one.
  const personalBotArchiveThreads = createEnvironmentRpcCommand(runtime, {
    label: "personal-bots:archive-threads",
    tag: WS_METHODS.personalBotsArchiveThreads,
    onSuccess: refreshBotsList,
  });

  const personalBotDeleteThreads = createEnvironmentRpcCommand(runtime, {
    label: "personal-bots:delete-threads",
    tag: WS_METHODS.personalBotsDeleteThreads,
    onSuccess: refreshBotsList,
  });

  /**
   * Pin, snooze or mark unread on one chat or a whole selection (one request,
   * one list refresh). The list carries `pinnedAt`, `snoozedUntil` and the
   * unread flags, so the screens redraw from the refetch.
   */
  const personalBotUpdateThreads = createEnvironmentRpcCommand(runtime, {
    label: "personal-bots:update-threads",
    tag: WS_METHODS.personalBotsUpdateThreads,
    onSuccess: refreshBotsList,
  });

  /** One-shot message search for the chat header's search field. */
  const personalBotsSearchMessages = createEnvironmentRpcCommand(runtime, {
    label: "personal-bots:search-messages",
    tag: WS_METHODS.personalBotsSearchMessages,
  });

  /** Warms a provider session before the first message, as the web does. */
  const personalBotsPrewarmThread = createEnvironmentRpcCommand(runtime, {
    label: "personal-bots:prewarm-thread",
    tag: WS_METHODS.personalBotsPrewarmThread,
  });

  /** Whole text behind a long-message preview, asked only when a row opens. */
  const personalBotsThreadFullText = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-bots:thread-full-text",
    tag: WS_METHODS.personalBotsThreadFullText,
    staleTimeMs: Number.POSITIVE_INFINITY,
    idleTtlMs: 5 * 60_000,
  });

  /** Unfinished tasks and the newest finished ones, replay then live upserts. */
  const personalTasksFeed = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "personal-tasks:feed",
    tag: WS_METHODS.personalTasksSubscribe,
    transform: foldPersonalTasksFeed,
  });

  /** One task with its attempts, children and work record, read only when opened. */
  const personalTasksGet = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-tasks:get",
    tag: WS_METHODS.personalTasksGet,
    staleTimeMs: 2_000,
  });

  const personalTasksCancel = createEnvironmentRpcCommand(runtime, {
    label: "personal-tasks:cancel",
    tag: WS_METHODS.personalTasksCancel,
  });

  /** A chat's own tasks and their children, beyond what the feed replays. */
  const personalTasksRelated = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-tasks:related",
    tag: WS_METHODS.personalTasksRelated,
    staleTimeMs: 30_000,
  });

  /**
   * Every team-lead request, pending and settled in the last week. Polled
   * because no subscription exists: a lead asking mid-conversation has to
   * surface without the owner reopening the chat.
   */
  const personalLeadBotChanges = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-lead-bot-changes:list",
    tag: WS_METHODS.personalLeadBotChangesList,
    staleTimeMs: 3_000,
    refreshIntervalMs: 6_000,
  });

  const personalLeadBotChangeDecide = createEnvironmentRpcCommand(runtime, {
    label: "personal-lead-bot-changes:decide",
    tag: WS_METHODS.personalLeadBotChangesDecide,
  });

  /** A bot's save or forget of memory other bots see, waiting for the owner. */
  const personalMemoryCards = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-memory:cards",
    tag: WS_METHODS.personalMemoryCards,
    staleTimeMs: 3_000,
  });

  const personalMemoryTidyDecide = createEnvironmentRpcCommand(runtime, {
    label: "personal-memory:tidy-decide",
    tag: WS_METHODS.personalMemoryTidyDecide,
  });

  /** How full the fullest bots' rules are, for the limit warning card. */
  const personalMemoryRulesUsage = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-memory:rules-usage",
    tag: WS_METHODS.personalMemoryRulesUsage,
    staleTimeMs: 10_000,
  });

  /** One turn's memory: rules, notes and why they matched. Read only when opened. */
  const personalMemoryTurnContext = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-memory:turn-context",
    tag: WS_METHODS.personalMemoryTurnContext,
    staleTimeMs: 30_000,
    idleTtlMs: 5 * 60_000,
  });

  const personalMemoryFeedback = createEnvironmentRpcCommand(runtime, {
    label: "personal-memory:feedback",
    tag: WS_METHODS.personalMemoryFeedback,
  });

  /**
   * Every secret a bot is waiting on. Polled: the server has no secret
   * subscription, and a request that lands while the chat is open still has to
   * surface without reopening the screen.
   */
  const personalSecretsListPending = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-secrets:pending",
    tag: WS_METHODS.personalSecretsListPending,
    staleTimeMs: 5_000,
    refreshIntervalMs: 15_000,
  });

  const personalSecretsFulfill = createEnvironmentRpcCommand(runtime, {
    label: "personal-secrets:fulfill",
    tag: WS_METHODS.personalSecretsFulfill,
  });

  const personalSecretsCancel = createEnvironmentRpcCommand(runtime, {
    label: "personal-secrets:cancel",
    tag: WS_METHODS.personalSecretsCancel,
  });

  /** Sign-in requests for one chat; the server keeps the settled rows for the card's ending. */
  const personalLoginRequests = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-login-requests:list",
    tag: WS_METHODS.personalLoginRequestsList,
    staleTimeMs: 2_000,
    refreshIntervalMs: 2_000,
  });

  const personalLoginRequestsSubmit = createEnvironmentRpcCommand(runtime, {
    label: "personal-login-requests:submit",
    tag: WS_METHODS.personalLoginRequestsSubmit,
  });

  const personalLoginRequestsCancel = createEnvironmentRpcCommand(runtime, {
    label: "personal-login-requests:cancel",
    tag: WS_METHODS.personalLoginRequestsCancel,
  });

  /**
   * Every gated vendor call waiting on the owner. Polled shorter than the
   * secret list: the task on the other end is blocked and the approval expires.
   */
  const personalConnectionApprovals = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-connection-approvals:pending",
    tag: WS_METHODS.personalConnectionApprovalsList,
    staleTimeMs: 3_000,
    refreshIntervalMs: 8_000,
  });

  const personalConnectionApprovalsDecide = createEnvironmentRpcCommand(runtime, {
    label: "personal-connection-approvals:decide",
    tag: WS_METHODS.personalConnectionApprovalsDecide,
  });

  const personalFileDelete = createEnvironmentRpcCommand(runtime, {
    label: "personal-files:delete",
    tag: WS_METHODS.personalFilesDelete,
    onSuccess: refreshFilesList,
  });

  const personalFilesDeleteMany = createEnvironmentRpcCommand(runtime, {
    label: "personal-files:delete-many",
    tag: WS_METHODS.personalFilesDeleteMany,
    onSuccess: refreshFilesList,
  });

  const personalProfileSet = createEnvironmentRpcCommand(runtime, {
    label: "personal-bots:set-profile",
    tag: WS_METHODS.personalBotsSetProfile,
    onSuccess: (target, registry) =>
      Effect.sync(() =>
        registry.refresh(personalProfile({ environmentId: target.environmentId, input: {} })),
      ),
  });

  /** The environment the personal shell talks to: the paired primary, else the active one. */
  function usePersonalEnvironmentId(): EnvironmentId | null {
    const primary = client.host.usePrimaryEnvironmentId();
    const active = client.host.useActiveEnvironmentId();
    return primary ?? active;
  }

  function usePersonalBotsList(
    environmentId: EnvironmentId | null,
  ): EnvironmentQueryView<PersonalBotsListResult> {
    const atom = useMemo(
      () =>
        environmentId === null
          ? null
          : personalBotsList({ environmentId, input: personalBotsListInput() }),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  function usePersonalRoutinesList(
    environmentId: EnvironmentId | null,
  ): EnvironmentQueryView<PersonalRoutineListResult> {
    const atom = useMemo(
      () => (environmentId === null ? null : personalRoutinesList({ environmentId, input: {} })),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  function useRemovedBots(
    environmentId: EnvironmentId | null,
  ): EnvironmentQueryView<PersonalRemovedBotsListResult> {
    const atom = useMemo(
      () => (environmentId === null ? null : personalRemovedBotsList({ environmentId, input: {} })),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  function useRestoreRemovedBot(
    environmentId: EnvironmentId | null,
  ): (botId: PersonalBotId) => Promise<RestoreOutcome> {
    const restoreRemovedBot = client.useAtomCommand(personalBotRestore, { reportFailure: false });
    return useCallback(
      async (botId) => {
        if (environmentId === null) {
          return { status: "failed", message: "Not connected to your computer." };
        }
        const result = await restoreRemovedBot({ environmentId, input: { botId } });
        const failure = commandFailureMessage(result, "Couldn't restore this bot. Try again.");
        if (failure !== null || result._tag !== "Success") {
          return { status: "failed", message: failure ?? "Couldn't restore this bot. Try again." };
        }
        return { status: "restored", result: result.value };
      },
      [environmentId, restoreRemovedBot],
    );
  }

  function usePersonalPushInApp(
    environmentId: EnvironmentId | null,
  ): EnvironmentQueryView<ReadonlyArray<PersonalPushInAppNotification>> {
    const atom = useMemo(
      () => (environmentId === null ? null : personalPushInAppFeed({ environmentId, input: {} })),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  /** Fetch only one bot's archived links, or an archived deep link, when needed. */
  function usePersonalArchivedLinks(
    environmentId: EnvironmentId | null,
    target: { readonly botId?: string; readonly threadId?: string } | null,
    listUpdatedAt: number | null,
  ): EnvironmentQueryView<PersonalBotsListResult> {
    const botId = target?.botId;
    const threadId = target?.threadId;
    const enabled = target !== null;
    const atom = useMemo(() => {
      if (environmentId === null || !enabled) return null;
      if (!perfOptimizationOn(client.ports.kv, "archive-links")) return null;
      return personalBotsList({
        environmentId,
        input: {
          omitArchived: true,
          ...(botId === undefined ? {} : { archivedBotId: botId }),
          ...(threadId === undefined ? {} : { archivedThreadId: threadId }),
        },
      });
    }, [environmentId, botId, threadId, enabled]);
    const result = client.useEnvironmentQuery(atom);
    const previous = useRef<{ atom: typeof atom; updatedAt: number | null }>({
      atom: null,
      updatedAt: null,
    });
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the list when the server's updatedAt moves
    useEffect(() => {
      const old = previous.current;
      previous.current = { atom, updatedAt: listUpdatedAt };
      if (
        atom !== null &&
        listUpdatedAt !== null &&
        ((old.atom === atom && old.updatedAt !== listUpdatedAt) ||
          (old.atom !== atom && result.data !== null))
      ) {
        // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the query view is stable per environment
        result.refresh();
      }
    }, [atom, listUpdatedAt, result.data, result.refresh]);
    return result;
  }

  function usePersonalFiles(
    environmentId: EnvironmentId | null,
  ): EnvironmentQueryView<PersonalFilesListResult> {
    const atom = useMemo(
      () => (environmentId === null ? null : personalFilesList({ environmentId, input: {} })),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  function usePersonalProfile(
    environmentId: EnvironmentId | null,
  ): EnvironmentQueryView<PersonalProfile> {
    const atom = useMemo(
      () => (environmentId === null ? null : personalProfile({ environmentId, input: {} })),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  const NO_HIDDEN_USAGE: ReadonlySet<string> = new Set();

  /**
   * Provider instances whose usage the owner turned off in Settings >
   * Providers. Empty until the profile has loaded; stable between renders.
   */
  function useHiddenUsageProviders(environmentId: EnvironmentId | null): ReadonlySet<string> {
    const hidden = usePersonalProfile(environmentId).data?.hiddenUsageProviders;
    return useMemo(
      () => (hidden === undefined || hidden.length === 0 ? NO_HIDDEN_USAGE : new Set(hidden)),
      [hidden],
    );
  }

  /** The zone "today" is cut in: this device's, else the app's own. */
  function deviceTimeZone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || PERSONAL_TIME_ZONE;
    } catch {
      return PERSONAL_TIME_ZONE;
    }
  }

  function usePersonalTokenUsage(
    environmentId: EnvironmentId | null,
  ): EnvironmentQueryView<PersonalBotTokenUsageResult> {
    const atom = useMemo(
      () =>
        environmentId === null
          ? null
          : personalBotsTokenUsage({ environmentId, input: { timeZone: deviceTimeZone() } }),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  /** The live bot-chat shells. Null until the snapshot lands. */
  function usePersonalBotShells(
    environmentId: EnvironmentId | null,
  ): EnvironmentQueryView<BotShellMap> {
    const atom = useMemo(
      () => (environmentId === null ? null : personalBotsShells({ environmentId, input: {} })),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  /** The live task feed. Null until the first replay value lands. */
  function usePersonalTasks(
    environmentId: EnvironmentId | null,
  ): EnvironmentQueryView<ReadonlyMap<string, PersonalTask>> {
    const atom = useMemo(
      () => (environmentId === null ? null : personalTasksFeed({ environmentId, input: {} })),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  function usePersonalRelatedTasks(
    environmentId: EnvironmentId | null,
    threadId: string,
  ): EnvironmentQueryView<PersonalTaskListResult> {
    const atom = useMemo(
      () =>
        environmentId === null || threadId.trim() === ""
          ? null
          : personalTasksRelated({ environmentId, input: { threadId: threadId as never } }),
      [environmentId, threadId],
    );
    return client.useEnvironmentQuery(atom);
  }

  function usePersonalTaskDetail(
    environmentId: EnvironmentId | null,
    taskId: string | null,
  ): EnvironmentQueryView<PersonalTaskDetail> {
    const atom = useMemo(
      () =>
        environmentId === null || taskId === null
          ? null
          : personalTasksGet({ environmentId, input: { taskId: taskId as never } }),
      [environmentId, taskId],
    );
    return client.useEnvironmentQuery(atom);
  }

  function usePersonalLeadBotChanges(
    environmentId: EnvironmentId | null,
  ): EnvironmentQueryView<PersonalLeadBotChangeListResult> {
    const atom = useMemo(
      () => (environmentId === null ? null : personalLeadBotChanges({ environmentId, input: {} })),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  function usePersonalMemoryCards(
    environmentId: EnvironmentId | null,
    threadId: string,
  ): EnvironmentQueryView<PersonalMemoryCardsResult> {
    const atom = useMemo(
      () =>
        environmentId === null || threadId.trim() === ""
          ? null
          : personalMemoryCards({ environmentId, input: { threadId: threadId as never } }),
      [environmentId, threadId],
    );
    return client.useEnvironmentQuery(atom);
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

  function usePersonalMemoryTurnContext(
    environmentId: EnvironmentId | null,
    input: { readonly threadId: string; readonly messageId: string } | null,
  ): EnvironmentQueryView<PersonalMemoryTurnContext | null> {
    const atom = useMemo(
      () =>
        environmentId === null || input === null
          ? null
          : personalMemoryTurnContext({
              environmentId,
              input: { threadId: input.threadId as never, messageId: input.messageId as never },
            }),
      [environmentId, input],
    );
    return client.useEnvironmentQuery(atom);
  }

  function usePersonalPendingSecrets(
    environmentId: EnvironmentId | null,
  ): EnvironmentQueryView<PersonalSecretsListPendingResult> {
    const atom = useMemo(
      () =>
        environmentId === null ? null : personalSecretsListPending({ environmentId, input: {} }),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  function usePersonalLoginRequests(
    environmentId: EnvironmentId | null,
    threadId: string,
  ): EnvironmentQueryView<{ readonly requests: ReadonlyArray<PersonalLoginRequest> }> {
    const atom = useMemo(
      () =>
        environmentId === null || threadId.trim() === ""
          ? null
          : personalLoginRequests({ environmentId, input: { threadId: threadId as never } }),
      [environmentId, threadId],
    );
    return client.useEnvironmentQuery(atom);
  }

  function usePersonalConnectionApprovals(
    environmentId: EnvironmentId | null,
  ): EnvironmentQueryView<PersonalConnectionApprovalListResult> {
    const atom = useMemo(
      () =>
        environmentId === null ? null : personalConnectionApprovals({ environmentId, input: {} }),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  return {
    personalBotsListInput,
    personalSecretsListPending,
    personalSecretsFulfill,
    personalSecretsCancel,
    personalLoginRequests,
    personalLoginRequestsSubmit,
    personalLoginRequestsCancel,
    personalConnectionApprovals,
    personalConnectionApprovalsDecide,
    usePersonalPendingSecrets,
    usePersonalLoginRequests,
    usePersonalConnectionApprovals,
    personalTasksFeed,
    personalTasksGet,
    personalTasksCancel,
    personalTasksRelated,
    personalLeadBotChanges,
    personalLeadBotChangeDecide,
    personalMemoryCards,
    personalMemoryTidyDecide,
    personalMemoryRulesUsage,
    personalMemoryTurnContext,
    personalMemoryFeedback,
    usePersonalMemoryTurnContext,
    usePersonalTasks,
    usePersonalRelatedTasks,
    usePersonalTaskDetail,
    usePersonalLeadBotChanges,
    usePersonalMemoryCards,
    usePersonalMemoryRulesUsage,
    personalBotsList,
    personalRemovedBotsList,
    personalPushInAppFeed,
    personalPushAckInApp,
    personalPushReportViewing,
    personalPushReportForeground,
    providerConsumeResetCredit,
    personalGroupsCreate,
    serverRefreshProviders,
    personalBotsShells,
    personalBotsWorkingProgress,
    personalProfile,
    personalFilesList,
    personalBotsTokenUsage,
    personalBotCreate,
    personalBotUpdate,
    personalBotsReorderPinned,
    personalProviderRecheck,
    personalBotDelete,
    personalBotRestore,
    personalBotCreateThread,
    personalBotArchiveThread,
    personalBotDeleteThread,
    personalBotArchiveThreads,
    personalBotDeleteThreads,
    personalBotUpdateThreads,
    personalBotsSearchMessages,
    personalBotsPrewarmThread,
    personalBotsThreadFullText,
    personalFileDelete,
    personalFilesDeleteMany,
    personalProfileSet,
    usePersonalEnvironmentId,
    usePersonalBotsList,
    usePersonalBotShells,
    useRemovedBots,
    useRestoreRemovedBot,
    usePersonalRoutinesList,
    usePersonalPushInApp,
    usePersonalArchivedLinks,
    usePersonalFiles,
    usePersonalProfile,
    useHiddenUsageProviders,
    usePersonalTokenUsage,
  };
}

export type PersonalBotsClient = ReturnType<typeof createPersonalBotsClient>;
