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

export const personalLoginsList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-logins:list",
  tag: WS_METHODS.personalLoginsList,
  staleTimeMs: 5_000,
});

type Registry = { refresh: (atom: ReturnType<typeof personalLoginsList>) => void };
const refreshLogins = (target: { readonly environmentId: EnvironmentId }, registry: Registry) =>
  Effect.sync(() =>
    registry.refresh(personalLoginsList({ environmentId: target.environmentId, input: {} })),
  );

export const personalLoginCreate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-logins:create",
  tag: WS_METHODS.personalLoginsCreate,
  onSuccess: refreshLogins,
});

export const personalLoginUpdate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-logins:update",
  tag: WS_METHODS.personalLoginsUpdate,
  onSuccess: refreshLogins,
});

export const personalLoginDelete = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-logins:delete",
  tag: WS_METHODS.personalLoginsDelete,
  onSuccess: refreshLogins,
});

export const personalLoginSetSensitive = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-logins:set-sensitive",
  tag: WS_METHODS.personalLoginsSetSensitive,
  onSuccess: refreshLogins,
});

export function usePersonalLogins(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () => (environmentId === null ? null : personalLoginsList({ environmentId, input: {} })),
    [environmentId],
  );
  return useEnvironmentQuery(atom);
}
