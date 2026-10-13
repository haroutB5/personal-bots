import { useMemo } from "react";

import type { EnvironmentId, PersonalLoginRequest } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentQuery } from "~/state/query";

import { openLoginRequests } from "./needsYou";

/**
 * The login requests that are still open, for the home's "Sign in" kind.
 *
 * The server keeps the whole machine's list (`personalLoginRequests.listPending`,
 * 1.67.0): it sweeps first, so an expired or resolved request is settled before
 * the answer, and a sign-in in a plain chat counts like one in a task chat.
 * Items are the same metadata-only shape as the per-chat list; a credential
 * never travels here. This replaced the tasks-feed heuristic (asking about the
 * chats the feed reported parked on the browser), which could not see plain
 * chats at all.
 */

const EMPTY: ReadonlyArray<PersonalLoginRequest> = [];

/** The same 2 s cadence the per-chat cards use: a login wait is a live thing. */
const personalLoginRequestsPending = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-login-requests:list-pending",
  tag: WS_METHODS.personalLoginRequestsListPending,
  staleTimeMs: 2_000,
  refreshIntervalMs: 2_000,
});

export function useNeedsYouLoginRequests(
  environmentId: EnvironmentId | null,
): ReadonlyArray<PersonalLoginRequest> {
  const atom = useMemo(
    () =>
      environmentId === null ? null : personalLoginRequestsPending({ environmentId, input: {} }),
    [environmentId],
  );
  const query = useEnvironmentQuery(atom);
  return useMemo(() => openLoginRequests(query.data?.requests ?? EMPTY), [query.data]);
}
