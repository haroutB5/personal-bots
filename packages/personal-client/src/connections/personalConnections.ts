import type { EnvironmentId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";
import { useMemo } from "react";

import type { PersonalClient } from "../client.ts";

/** Accounts bots can act on. The server holds every token; the list has none. */
export function createPersonalConnectionsClient<R, ER, P>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  client: PersonalClient<R, ER, P>,
) {
  const personalConnectionsList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-connections:list",
    tag: WS_METHODS.personalConnectionsList,
    staleTimeMs: 5_000,
    idleTtlMs: 5 * 60_000,
  });

  const refreshConnections = (
    target: { readonly environmentId: EnvironmentId },
    registry: { refresh: (atom: ReturnType<typeof personalConnectionsList>) => void },
  ) =>
    Effect.sync(() =>
      registry.refresh(personalConnectionsList({ environmentId: target.environmentId, input: {} })),
    );

  const personalConnectionConnect = createEnvironmentRpcCommand(runtime, {
    label: "personal-connections:connect",
    tag: WS_METHODS.personalConnectionsConnect,
    onSuccess: refreshConnections,
  });

  const personalConnectionValidate = createEnvironmentRpcCommand(runtime, {
    label: "personal-connections:validate",
    tag: WS_METHODS.personalConnectionsValidate,
    onSuccess: refreshConnections,
  });

  const personalConnectionDisable = createEnvironmentRpcCommand(runtime, {
    label: "personal-connections:disable",
    tag: WS_METHODS.personalConnectionsDisable,
    onSuccess: refreshConnections,
  });

  const personalConnectionReconnect = createEnvironmentRpcCommand(runtime, {
    label: "personal-connections:reconnect",
    tag: WS_METHODS.personalConnectionsReconnect,
    onSuccess: refreshConnections,
  });

  const personalConnectionDisconnect = createEnvironmentRpcCommand(runtime, {
    label: "personal-connections:disconnect",
    tag: WS_METHODS.personalConnectionsDisconnect,
    onSuccess: refreshConnections,
  });

  const personalConnectionRotate = createEnvironmentRpcCommand(runtime, {
    label: "personal-connections:rotate",
    tag: WS_METHODS.personalConnectionsRotate,
    onSuccess: refreshConnections,
  });

  const personalConnectionBrowserConnect = createEnvironmentRpcCommand(runtime, {
    label: "personal-connections:browser-connect",
    tag: WS_METHODS.personalConnectionsBrowserConnect,
    onSuccess: refreshConnections,
  });

  const personalConnectionSetSettings = createEnvironmentRpcCommand(runtime, {
    label: "personal-connections:set-settings",
    tag: WS_METHODS.personalConnectionsSetSettings,
    onSuccess: refreshConnections,
  });

  const personalConnectionImportProbe = createEnvironmentRpcCommand(runtime, {
    label: "personal-connections:import-probe",
    tag: WS_METHODS.personalConnectionsImportProbe,
  });

  const personalConnectionImportAdopt = createEnvironmentRpcCommand(runtime, {
    label: "personal-connections:import-adopt",
    tag: WS_METHODS.personalConnectionsImportAdopt,
    onSuccess: refreshConnections,
  });

  function usePersonalConnections(environmentId: EnvironmentId | null) {
    const atom = useMemo(
      () => (environmentId === null ? null : personalConnectionsList({ environmentId, input: {} })),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  return {
    personalConnectionsList,
    personalConnectionConnect,
    personalConnectionValidate,
    personalConnectionDisable,
    personalConnectionReconnect,
    personalConnectionDisconnect,
    personalConnectionRotate,
    personalConnectionBrowserConnect,
    personalConnectionSetSettings,
    personalConnectionImportProbe,
    personalConnectionImportAdopt,
    usePersonalConnections,
  };
}

export type PersonalConnectionsClient = ReturnType<typeof createPersonalConnectionsClient>;
