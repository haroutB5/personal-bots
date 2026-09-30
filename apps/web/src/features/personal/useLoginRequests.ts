import { useMemo, useState } from "react";
import type { EnvironmentId, PersonalLoginRequest } from "@t3tools/contracts";
import { ThreadId, WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import type { ProvideLogin } from "./LoginRequestCard";

const EMPTY: ReadonlyArray<PersonalLoginRequest> = [];
export const personalLoginRequests = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-login-requests:list",
  tag: WS_METHODS.personalLoginRequestsList,
  staleTimeMs: 2_000,
  refreshIntervalMs: 2_000,
});
const submitLogin = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-login-requests:submit",
  tag: WS_METHODS.personalLoginRequestsSubmit,
});
const cancelLogin = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-login-requests:cancel",
  tag: WS_METHODS.personalLoginRequestsCancel,
});

/** Only request metadata is cached. Both credential fields arrive already redacted. */
export function useLoginRequestCards(environmentId: EnvironmentId | null, threadId: string) {
  const atom = useMemo(
    () =>
      environmentId === null
        ? null
        : personalLoginRequests({
            environmentId,
            input: { threadId: ThreadId.make(threadId) },
          }),
    [environmentId, threadId],
  );
  const query = useEnvironmentQuery(atom);
  const requests = query.data?.requests ?? EMPTY;
  const [statuses, setStatuses] = useState<ReadonlyMap<string, PersonalLoginRequest["status"]>>(
    () => new Map(),
  );
  const [saved, setSaved] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const submit = useAtomCommand(submitLogin, { reportFailure: false, reportDefect: false });
  const cancel = useAtomCommand(cancelLogin, { reportFailure: false, reportDefect: false });
  const cards = useMemo(
    () =>
      requests
        .filter((request) => String(request.threadId) === threadId)
        .map((request) => ({
          ...request,
          status:
            request.status === "pending" || request.status === "filling"
              ? (statuses.get(request.requestId) ?? request.status)
              : request.status,
          saved: saved.get(request.requestId) ?? request.saved,
        })),
    [requests, threadId, statuses, saved],
  );
  const mark = (requestId: string, status: PersonalLoginRequest["status"]) =>
    setStatuses((current) => new Map(current).set(requestId, status));
  const provide: ProvideLogin = async (requestId, username, password, save) => {
    if (environmentId === null) return;
    mark(requestId, "filling");
    const result = await submit({ environmentId, input: { requestId, username, password, save } });
    // Never surface a transport error which might contain its request payload.
    mark(requestId, result._tag === "Success" ? result.value.status : "fill-failed");
    if (result._tag === "Success")
      setSaved((current) => new Map(current).set(requestId, result.value.saved));
    query.refresh();
  };
  const cancelRequest = async (requestId: string) => {
    if (environmentId === null) return;
    mark(requestId, "filling");
    const result = await cancel({ environmentId, input: { requestId } });
    mark(requestId, result._tag === "Success" ? result.value.status : "fill-failed");
    query.refresh();
  };
  return { cards, provide, cancel: cancelRequest };
}
