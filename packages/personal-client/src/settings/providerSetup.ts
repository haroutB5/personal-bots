import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import type { PersonalClient } from "../client.ts";
import type { EnvironmentQueryView } from "../react/query.ts";

/**
 * Provider setup over the phone: the catalogue, the live install and sign-in
 * streams, and the settings write that turns an instance on or off. The web
 * screen uses the same RPCs; the phone needs its own atoms because it has no
 * web server environment.
 */
export function createProviderSetupClient<R, ER, P>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  client: PersonalClient<R, ER, P>,
) {
  const serverSettings = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "settings:server",
    tag: WS_METHODS.serverGetSettings,
    staleTimeMs: 10_000,
    idleTtlMs: 5 * 60_000,
  });

  const providerCatalog = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "provider:catalog",
    tag: WS_METHODS.providerCatalogList,
    staleTimeMs: 60_000,
    idleTtlMs: 5 * 60_000,
  });

  const providerInstallFacts = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "provider:catalog:install-facts",
    tag: WS_METHODS.providerCatalogInstallFacts,
    staleTimeMs: 60_000,
    idleTtlMs: 5 * 60_000,
  });

  const providerInstallState = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "provider:install-state",
    tag: WS_METHODS.providerInstallSubscribe,
    idleTtlMs: 0,
  });

  const providerAuthState = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "provider:auth-state",
    tag: WS_METHODS.providerAuthSubscribe,
    idleTtlMs: 0,
  });

  const refreshSettings = (
    target: { readonly environmentId: EnvironmentId },
    registry: { refresh: (atom: ReturnType<typeof serverSettings>) => void },
  ) =>
    Effect.sync(() => {
      registry.refresh(serverSettings({ environmentId: target.environmentId, input: {} }));
    });

  const updateServerSettings = createEnvironmentRpcCommand(runtime, {
    label: "settings:server:update",
    tag: WS_METHODS.serverUpdateSettings,
    onSuccess: refreshSettings,
  });

  const startProviderInstall = createEnvironmentRpcCommand(runtime, {
    label: "provider:install-start",
    tag: WS_METHODS.providerInstallStart,
  });

  const cancelProviderInstall = createEnvironmentRpcCommand(runtime, {
    label: "provider:install-cancel",
    tag: WS_METHODS.providerInstallCancel,
  });

  const removeProviderInstall = createEnvironmentRpcCommand(runtime, {
    label: "provider:install-remove",
    tag: WS_METHODS.providerInstallRemove,
  });

  const runProviderTest = createEnvironmentRpcCommand(runtime, {
    label: "provider:test-run",
    tag: WS_METHODS.providerTestRun,
  });

  const startProviderAuth = createEnvironmentRpcCommand(runtime, {
    label: "provider:auth-start",
    tag: WS_METHODS.providerAuthStart,
  });

  const completeProviderAuth = createEnvironmentRpcCommand(runtime, {
    label: "provider:auth-complete",
    tag: WS_METHODS.providerAuthComplete,
  });

  const cancelProviderAuth = createEnvironmentRpcCommand(runtime, {
    label: "provider:auth-cancel",
    tag: WS_METHODS.providerAuthCancel,
  });

  const logoutProviderAuth = createEnvironmentRpcCommand(runtime, {
    label: "provider:auth-logout",
    tag: WS_METHODS.providerAuthLogout,
  });

  const addProviderFromCatalog = createEnvironmentRpcCommand(runtime, {
    label: "provider:catalog:add",
    tag: WS_METHODS.providerCatalogAdd,
  });

  const updateProvider = createEnvironmentRpcCommand(runtime, {
    label: "server:update-provider",
    tag: WS_METHODS.serverUpdateProvider,
  });

  function useServerSettings(
    environmentId: EnvironmentId | null,
  ): EnvironmentQueryView<ServerSettings> {
    const atom = useMemo(
      () => (environmentId === null ? null : serverSettings({ environmentId, input: {} })),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  function useProviderCatalog(environmentId: EnvironmentId | null, refresh = false) {
    const atom = useMemo(
      () =>
        environmentId === null
          ? null
          : providerCatalog({ environmentId, input: refresh ? { refresh: true } : {} }),
      [environmentId, refresh],
    );
    return client.useEnvironmentQuery(atom);
  }

  function useProviderInstallFacts(environmentId: EnvironmentId | null, catalogId: string | null) {
    const atom = useMemo(
      () =>
        environmentId === null || catalogId === null
          ? null
          : providerInstallFacts({ environmentId, input: { catalogId } }),
      [catalogId, environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  function useProviderInstallState(
    environmentId: EnvironmentId | null,
    instanceId: ProviderInstanceId | null,
  ) {
    const atom = useMemo(
      () =>
        environmentId === null || instanceId === null
          ? null
          : providerInstallState({ environmentId, input: { instanceId } }),
      [environmentId, instanceId],
    );
    return client.useEnvironmentQuery(atom);
  }

  function useProviderAuthState(
    environmentId: EnvironmentId | null,
    instanceId: ProviderInstanceId | null,
  ) {
    const atom = useMemo(
      () =>
        environmentId === null || instanceId === null
          ? null
          : providerAuthState({ environmentId, input: { instanceId } }),
      [environmentId, instanceId],
    );
    return client.useEnvironmentQuery(atom);
  }

  function useProviderSettingsWriter(environmentId: EnvironmentId | null) {
    const write = client.useAtomCommand(updateServerSettings, { reportFailure: false });
    return useCallback(
      async (patch: ServerSettingsPatch) => {
        if (environmentId === null) return null;
        return write({ environmentId, input: { patch } });
      },
      [environmentId, write],
    );
  }

  return {
    serverSettings,
    providerCatalog,
    providerInstallFacts,
    providerInstallState,
    providerAuthState,
    updateServerSettings,
    startProviderInstall,
    cancelProviderInstall,
    removeProviderInstall,
    runProviderTest,
    startProviderAuth,
    completeProviderAuth,
    cancelProviderAuth,
    logoutProviderAuth,
    addProviderFromCatalog,
    updateProvider,
    useServerSettings,
    useProviderCatalog,
    useProviderInstallFacts,
    useProviderInstallState,
    useProviderAuthState,
    useProviderSettingsWriter,
  };
}

export type ProviderSetupClient = ReturnType<typeof createProviderSetupClient>;
