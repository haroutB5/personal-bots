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
 * Every team-lead request to remove or rewrite a bot: the pending ones and the
 * ones settled in the last week.
 *
 * Polled like the connection approvals, and for the same reason: no
 * subscription exists, and a lead that asks mid-conversation has to surface
 * without the owner reopening the chat. The request expires, so a slow poll
 * would spend the owner's window on nothing.
 */
export const personalLeadBotChanges = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-lead-bot-changes:list",
  tag: WS_METHODS.personalLeadBotChangesList,
  staleTimeMs: 3_000,
  refreshIntervalMs: 6_000,
});

type Registry = {
  refresh: (atom: ReturnType<typeof personalLeadBotChanges>) => void;
};
const refreshChanges = (target: { readonly environmentId: EnvironmentId }, registry: Registry) =>
  Effect.sync(() =>
    registry.refresh(personalLeadBotChanges({ environmentId: target.environmentId, input: {} })),
  );

/** Answer one request. The server re-checks the hash before it changes any bot. */
export const personalLeadBotChangeDecide = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-lead-bot-changes:decide",
  tag: WS_METHODS.personalLeadBotChangesDecide,
  onSuccess: refreshChanges,
});

export function useLeadBotChangesQuery(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () => (environmentId === null ? null : personalLeadBotChanges({ environmentId, input: {} })),
    [environmentId],
  );
  return useEnvironmentQuery(atom);
}
