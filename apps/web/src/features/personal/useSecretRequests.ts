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

/**
 * Every secret a bot is waiting on. Rows carry the name, label and purpose and
 * never a value (`PersonalSecretRequest` has no field that could hold one).
 *
 * Polled rather than streamed: the server has no secret subscription, and a
 * request that lands while the chat is open must still surface without the
 * user reopening the screen.
 */
export const personalSecretsPending = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-secrets:pending",
  tag: WS_METHODS.personalSecretsListPending,
  staleTimeMs: 5_000,
  refreshIntervalMs: 15_000,
});

type Registry = { refresh: (atom: ReturnType<typeof personalSecretsPending>) => void };
const refreshPending = (target: { readonly environmentId: EnvironmentId }, registry: Registry) =>
  Effect.sync(() =>
    registry.refresh(personalSecretsPending({ environmentId: target.environmentId, input: {} })),
  );

/**
 * Stores the value and resumes the bot's task.
 *
 * The payload's `value` is `Schema.Redacted`, so it is wrapped with
 * `Redacted.make` at the call site, never logged by the command layer, and the
 * success payload is the request row without it.
 */
export const personalSecretFulfill = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-secrets:fulfill",
  tag: WS_METHODS.personalSecretsFulfill,
  onSuccess: refreshPending,
});

/** Declines a request: the row is cancelled and the waiting task fails. */
export const personalSecretCancel = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-secrets:cancel",
  tag: WS_METHODS.personalSecretsCancel,
  onSuccess: refreshPending,
});

export function usePendingSecretRequests(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () => (environmentId === null ? null : personalSecretsPending({ environmentId, input: {} })),
    [environmentId],
  );
  return useEnvironmentQuery(atom);
}

export const personalSavedSecrets = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-secrets:list",
  tag: WS_METHODS.personalSecretsList,
  staleTimeMs: 5_000,
});

export const personalSecretSetSharing = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-secrets:sharing",
  tag: WS_METHODS.personalSecretsSetSharing,
  onSuccess: (target, registry) =>
    Effect.sync(() =>
      registry.refresh(personalSavedSecrets({ environmentId: target.environmentId, input: {} })),
    ),
});

export function useSavedSecrets(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () => (environmentId === null ? null : personalSavedSecrets({ environmentId, input: {} })),
    [environmentId],
  );
  return useEnvironmentQuery(atom);
}
