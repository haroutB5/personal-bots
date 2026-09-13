import type { EnvironmentId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useActiveEnvironmentId } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";

/** Bots, bot-thread links and the personal project id for one environment. */
export const personalBotsList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-bots:list",
  tag: WS_METHODS.personalBotsList,
  staleTimeMs: 10_000,
  idleTtlMs: 5 * 60_000,
});

/** Greeting display name (empty string = unset). */
export const personalProfile = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-bots:profile",
  tag: WS_METHODS.personalBotsGetProfile,
  staleTimeMs: 60_000,
  idleTtlMs: 10 * 60_000,
});

/**
 * Files-tab rows with signed asset URLs. The server's URLs live for an hour,
 * so the list refreshes well inside that while the tab is mounted.
 */
export const personalFilesList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-bots:files",
  tag: WS_METHODS.personalBotsListFiles,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
  refreshIntervalMs: 20 * 60_000,
});

const refreshBotsList = (
  target: { readonly environmentId: EnvironmentId },
  registry: { refresh: (atom: ReturnType<typeof personalBotsList>) => void },
) =>
  Effect.sync(() =>
    registry.refresh(personalBotsList({ environmentId: target.environmentId, input: {} })),
  );

export const personalBotCreate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-bots:create",
  tag: WS_METHODS.personalBotsCreate,
  onSuccess: refreshBotsList,
});

export const personalBotUpdate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-bots:update",
  tag: WS_METHODS.personalBotsUpdate,
  onSuccess: refreshBotsList,
});

export const personalBotDelete = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-bots:delete",
  tag: WS_METHODS.personalBotsDelete,
  onSuccess: refreshBotsList,
});

export const personalBotCreateThread = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-bots:create-thread",
  tag: WS_METHODS.personalBotsCreateThread,
  onSuccess: refreshBotsList,
});

export const personalBotArchiveThread = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-bots:archive-thread",
  tag: WS_METHODS.personalBotsArchiveThread,
  onSuccess: refreshBotsList,
});

export const personalBotDeleteThread = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-bots:delete-thread",
  tag: WS_METHODS.personalBotsDeleteThread,
  onSuccess: refreshBotsList,
});

export const personalProfileSet = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-bots:set-profile",
  tag: WS_METHODS.personalBotsSetProfile,
  onSuccess: (target, registry) =>
    Effect.sync(() =>
      registry.refresh(personalProfile({ environmentId: target.environmentId, input: {} })),
    ),
});

/** The environment the personal shell talks to: the paired primary, else the active one. */
export function usePersonalEnvironmentId(): EnvironmentId | null {
  const primary = usePrimaryEnvironmentId();
  const active = useActiveEnvironmentId();
  return primary ?? active;
}

export function usePersonalBotsList(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () => (environmentId === null ? null : personalBotsList({ environmentId, input: {} })),
    [environmentId],
  );
  return useEnvironmentQuery(atom);
}

export function usePersonalFiles(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () => (environmentId === null ? null : personalFilesList({ environmentId, input: {} })),
    [environmentId],
  );
  return useEnvironmentQuery(atom);
}

export function usePersonalProfile(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () => (environmentId === null ? null : personalProfile({ environmentId, input: {} })),
    [environmentId],
  );
  return useEnvironmentQuery(atom);
}
