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

/** Saved API keys: summaries only. A value is accepted once and never read back. */
export function createPersonalSecretsClient<R, ER, P>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  client: PersonalClient<R, ER, P>,
) {
  const personalSavedSecrets = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "personal-secrets:list",
    tag: WS_METHODS.personalSecretsList,
    staleTimeMs: 5_000,
    idleTtlMs: 5 * 60_000,
  });

  const refreshSecrets = (
    target: { readonly environmentId: EnvironmentId },
    registry: { refresh: (atom: ReturnType<typeof personalSavedSecrets>) => void },
  ) =>
    Effect.sync(() =>
      registry.refresh(personalSavedSecrets({ environmentId: target.environmentId, input: {} })),
    );

  const personalSecretCreate = createEnvironmentRpcCommand(runtime, {
    label: "personal-secrets:create",
    tag: WS_METHODS.personalSecretsCreate,
    onSuccess: refreshSecrets,
  });

  const personalSecretSetSharing = createEnvironmentRpcCommand(runtime, {
    label: "personal-secrets:sharing",
    tag: WS_METHODS.personalSecretsSetSharing,
    onSuccess: refreshSecrets,
  });

  const personalSecretSetMode = createEnvironmentRpcCommand(runtime, {
    label: "personal-secrets:mode",
    tag: WS_METHODS.personalSecretsSetMode,
    onSuccess: refreshSecrets,
  });

  const personalSecretDelete = createEnvironmentRpcCommand(runtime, {
    label: "personal-secrets:delete",
    tag: WS_METHODS.personalSecretsDelete,
    onSuccess: refreshSecrets,
  });

  function useSavedSecrets(environmentId: EnvironmentId | null) {
    const atom = useMemo(
      () => (environmentId === null ? null : personalSavedSecrets({ environmentId, input: {} })),
      [environmentId],
    );
    return client.useEnvironmentQuery(atom);
  }

  return {
    personalSavedSecrets,
    personalSecretCreate,
    personalSecretSetSharing,
    personalSecretSetMode,
    personalSecretDelete,
    useSavedSecrets,
  };
}

export type PersonalSecretsClient = ReturnType<typeof createPersonalSecretsClient>;
