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
 * Every gated vendor call waiting on the owner.
 *
 * Polled like the secret requests, and for the same reason: there is no
 * subscription for approvals, and a bot that parks on one mid-conversation has
 * to surface without the owner reopening the screen. The interval is shorter
 * than the secrets one because the task on the other end is blocked and its
 * approval expires, so a slow poll spends the owner's window on nothing.
 */
export const personalConnectionApprovalsPending = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "personal-connection-approvals:pending",
    tag: WS_METHODS.personalConnectionApprovalsList,
    staleTimeMs: 3_000,
    refreshIntervalMs: 8_000,
  },
);

type Registry = {
  refresh: (atom: ReturnType<typeof personalConnectionApprovalsPending>) => void;
};
const refreshPending = (target: { readonly environmentId: EnvironmentId }, registry: Registry) =>
  Effect.sync(() =>
    registry.refresh(
      personalConnectionApprovalsPending({ environmentId: target.environmentId, input: {} }),
    ),
  );

/** Approve or deny one action. The server re-checks the binding before it dispatches anything. */
export const personalConnectionApprovalDecide = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-connection-approvals:decide",
  tag: WS_METHODS.personalConnectionApprovalsDecide,
  onSuccess: refreshPending,
});

export function usePendingConnectionApprovals(environmentId: EnvironmentId | null) {
  const atom = useMemo(
    () =>
      environmentId === null
        ? null
        : personalConnectionApprovalsPending({ environmentId, input: {} }),
    [environmentId],
  );
  return useEnvironmentQuery(atom);
}
