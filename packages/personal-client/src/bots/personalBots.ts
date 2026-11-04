import type {
  EnvironmentId,
  PersonalBotsListResult,
  PersonalBotTokenUsageResult,
  PersonalFilesListResult,
  PersonalProfile,
  PersonalPushInAppNotification,
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
import type { Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef } from "react";

import type { PersonalClient } from "../client.ts";
import { PERSONAL_TIME_ZONE } from "../conversation/greeting.ts";
import { perfOptimizationOn } from "../perf/perfFlags.ts";
import type { EnvironmentQueryView } from "../react/query.ts";

/**
 * Builds the bots list, its profile and file queries, every mutation the
 * personal screens run, and the hooks they read. The app owns the connection
 * runtime and the ports, so the package owns no web singleton and no
 * environment selection.
 */
export function createPersonalBotsClient<R, ER, P>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
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
        Stream.scan([] as ReadonlyArray<PersonalPushInAppNotification>, (recent, notification) =>
          [...recent, notification].slice(-IN_APP_FEED_KEEP),
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

  /** The slim shell leaves out archived bot chats; a screen asks for them here. */
  const personalBotsThreadShells = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-bots:thread-shells",
    tag: WS_METHODS.personalBotsThreadShells,
    staleTimeMs: 30_000,
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
    useEffect(() => {
      const old = previous.current;
      previous.current = { atom, updatedAt: listUpdatedAt };
      if (
        atom !== null &&
        listUpdatedAt !== null &&
        ((old.atom === atom && old.updatedAt !== listUpdatedAt) ||
          (old.atom !== atom && result.data !== null))
      ) {
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

  return {
    personalBotsListInput,
    personalBotsList,
    personalPushInAppFeed,
    personalPushAckInApp,
    personalPushReportViewing,
    personalPushReportForeground,
    providerConsumeResetCredit,
    personalGroupsCreate,
    serverRefreshProviders,
    personalBotsThreadShells,
    personalBotsWorkingProgress,
    personalProfile,
    personalFilesList,
    personalBotsTokenUsage,
    personalBotCreate,
    personalBotUpdate,
    personalProviderRecheck,
    personalBotDelete,
    personalBotCreateThread,
    personalBotArchiveThread,
    personalBotDeleteThread,
    personalBotArchiveThreads,
    personalBotDeleteThreads,
    personalBotUpdateThreads,
    personalFileDelete,
    personalFilesDeleteMany,
    personalProfileSet,
    usePersonalEnvironmentId,
    usePersonalBotsList,
    usePersonalPushInApp,
    usePersonalArchivedLinks,
    usePersonalFiles,
    usePersonalProfile,
    useHiddenUsageProviders,
    usePersonalTokenUsage,
  };
}

export type PersonalBotsClient = ReturnType<typeof createPersonalBotsClient>;
