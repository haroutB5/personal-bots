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

/** Saved website logins: summaries only, values are write-only. */
export function createPersonalLoginsClient<R, ER, P>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  client: PersonalClient<R, ER, P>,
) {
  const personalLoginsList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-logins:list",
    tag: WS_METHODS.personalLoginsList,
    staleTimeMs: 5_000,
    idleTtlMs: 5 * 60_000,
  });

  const refreshLogins = (
    target: { readonly environmentId: EnvironmentId },
    registry: { refresh: (atom: ReturnType<typeof personalLoginsList>) => void },
  ) =>
    Effect.sync(() =>
      registry.refresh(personalLoginsList({ environmentId: target.environmentId, input: {} })),
    );

  const personalLoginCreate = createEnvironmentRpcCommand(runtime, {
    label: "personal-logins:create",
    tag: WS_METHODS.personalLoginsCreate,
    onSuccess: refreshLogins,
  });

  const personalLoginUpdate = createEnvironmentRpcCommand(runtime, {
    label: "personal-logins:update",
    tag: WS_METHODS.personalLoginsUpdate,
    onSuccess: refreshLogins,
  });

  const personalLoginDelete = createEnvironmentRpcCommand(runtime, {
    label: "personal-logins:delete",
    tag: WS_METHODS.personalLoginsDelete,
    onSuccess: refreshLogins,
  });

  const personalLoginsDeleteMany = createEnvironmentRpcCommand(runtime, {
    label: "personal-logins:delete-many",
    tag: WS_METHODS.personalLoginsDeleteMany,
    onSuccess: refreshLogins,
  });

  const personalLoginSetSensitive = createEnvironmentRpcCommand(runtime, {
    label: "personal-logins:set-sensitive",
    tag: WS_METHODS.personalLoginsSetSensitive,
    onSuccess: refreshLogins,
  });

  function usePersonalLogins(environmentId: EnvironmentId | null) {
    const atom = useMemo(
      () => (environmentId === null ? null : personalLoginsList({ environmentId, input: {} })),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  return {
    personalLoginsList,
    personalLoginCreate,
    personalLoginUpdate,
    personalLoginDelete,
    personalLoginsDeleteMany,
    personalLoginSetSensitive,
    usePersonalLogins,
  };
}

export type PersonalLoginsClient = ReturnType<typeof createPersonalLoginsClient>;
