import { useMemo } from "react";

import { ThreadId, type EnvironmentId, type PersonalLoginRequest } from "@t3tools/contracts";

import { useEnvironmentQuery } from "~/state/query";

import { personalLoginRequests } from "./useLoginRequests";

/**
 * The login requests that are still open, for the home's "Sign in" kind.
 *
 * The login-request RPC is per chat (`personalLoginRequests.list { threadId }`),
 * and there is no global list yet, so the home asks about the chats that could
 * have one: the tasks the feed reports as parked on the browser
 * (`waiting_for_browser`, the status the login card and browser help leave
 * behind). That set is small (a couple of chats at most), and the queries are
 * only mounted for those chats.
 *
 * The slots are fixed: the hook count never changes with the data, so React's
 * order is stable at every render. When the server grows a global
 * pending-login list (named in the 1.67.0 result), this file is the only one
 * that changes.
 */

/** How many browser-waiting chats the home asks about at once. */
export const LOGIN_REQUEST_SLOTS = 3;

const EMPTY: ReadonlyArray<PersonalLoginRequest> = [];

function useLoginRequestsForThread(environmentId: EnvironmentId | null, threadId: string | null) {
  const atom = useMemo(
    () =>
      environmentId === null || threadId === null
        ? null
        : personalLoginRequests({ environmentId, input: { threadId: ThreadId.make(threadId) } }),
    [environmentId, threadId],
  );
  return useEnvironmentQuery(atom);
}

export function useNeedsYouLoginRequests(
  environmentId: EnvironmentId | null,
  /** The chat ids parked on the browser, from the tasks feed. */
  browserWaitingThreadIds: ReadonlyArray<string>,
): ReadonlyArray<PersonalLoginRequest> {
  const slotsWanted = browserWaitingThreadIds.slice(0, LOGIN_REQUEST_SLOTS);
  const first = useLoginRequestsForThread(environmentId, slotsWanted[0] ?? null);
  const second = useLoginRequestsForThread(environmentId, slotsWanted[1] ?? null);
  const third = useLoginRequestsForThread(environmentId, slotsWanted[2] ?? null);
  const slots = [first.data, second.data, third.data] as const;
  return useMemo(() => {
    const open = slots.flatMap((data) => data?.requests ?? EMPTY);
    return open.filter((request) => request.status === "pending" || request.status === "filling");
  }, [first.data, second.data, third.data]);
}
