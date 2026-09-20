import type { EnvironmentId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";

export const personalConnectionsList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-connections:list",
  tag: WS_METHODS.personalConnectionsList,
  staleTimeMs: 5_000,
});

type Registry = { refresh: (atom: ReturnType<typeof personalConnectionsList>) => void };
const refreshConnections = (
  target: { readonly environmentId: EnvironmentId },
  registry: Registry,
) =>
  Effect.sync(() =>
    registry.refresh(personalConnectionsList({ environmentId: target.environmentId, input: {} })),
  );

export const personalConnectionConnect = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-connections:connect",
  tag: WS_METHODS.personalConnectionsConnect,
  onSuccess: refreshConnections,
});

export const personalConnectionValidate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-connections:validate",
  tag: WS_METHODS.personalConnectionsValidate,
  onSuccess: refreshConnections,
});

export const personalConnectionDisable = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-connections:disable",
  tag: WS_METHODS.personalConnectionsDisable,
  onSuccess: refreshConnections,
});

export const personalConnectionReconnect = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-connections:reconnect",
  tag: WS_METHODS.personalConnectionsReconnect,
  onSuccess: refreshConnections,
});

export const personalConnectionDisconnect = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-connections:disconnect",
  tag: WS_METHODS.personalConnectionsDisconnect,
  onSuccess: refreshConnections,
});

export const personalConnectionRotate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-connections:rotate",
  tag: WS_METHODS.personalConnectionsRotate,
  onSuccess: refreshConnections,
});

/**
 * Probing the machine is a command, not a query: it reads the filesystem, so
 * it runs when the owner asks rather than whenever a screen mounts.
 */
export const personalConnectionImportProbe = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-connections:import-probe",
  tag: WS_METHODS.personalConnectionsImportProbe,
});

export const personalConnectionImportAdopt = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-connections:import-adopt",
  tag: WS_METHODS.personalConnectionsImportAdopt,
  onSuccess: refreshConnections,
});

export function usePersonalConnections(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () => (environmentId === null ? null : personalConnectionsList({ environmentId, input: {} })),
    [environmentId],
  );
  return useEnvironmentQuery(atom);
}
