import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationThreadShell,
  PersonalBotThreadShellsInput,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

/**
 * The personal shell stream carries open chats only. Screens that show archived
 * chats ask for them here, and useBotShells adds each answer while they ask.
 */
export const personalThreadShells = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-bots:thread-shells",
  tag: WS_METHODS.personalBotsThreadShells,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

export type LazyThreadShellRequest =
  | { readonly botId: string }
  | { readonly threadIds: ReadonlyArray<string> };

function requestKey(request: LazyThreadShellRequest): string {
  return "botId" in request
    ? `bot:${request.botId}`
    : `threads:${[...new Set(request.threadIds)].toSorted().join(",")}`;
}

function requestInput(key: string): PersonalBotThreadShellsInput {
  if (key.startsWith("bot:")) {
    return { botId: key.slice("bot:".length) as PersonalBotThreadShellsInput["botId"] & string };
  }
  return {
    threadIds: key
      .slice("threads:".length)
      .split(",")
      .filter((id) => id.length > 0) as unknown as NonNullable<
      PersonalBotThreadShellsInput["threadIds"]
    >,
  };
}

/** Request key -> how many mounted screens ask for it. */
const lazyRequestsAtom = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make<ReadonlyMap<string, number>>(new Map()).pipe(Atom.keepAlive),
);

const queryAtom = (environmentId: EnvironmentId, key: string) =>
  personalThreadShells({ environmentId, input: requestInput(key) });

/** The answers to every request a mounted screen holds, in request order. */
const archivedShellsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<ReadonlyArray<OrchestrationThreadShell>> => {
    const answers: Array<ReadonlyArray<OrchestrationThreadShell>> = [];
    for (const key of get(lazyRequestsAtom(environmentId)).keys()) {
      const value = AsyncResult.value(get(queryAtom(environmentId, key)));
      if (Option.isSome(value)) answers.push(value.value.threads);
    }
    return answers;
  }).pipe(Atom.withLabel(`personal-archived-shells:${environmentId}`)),
);

export function useArchivedThreadShells(
  environmentId: EnvironmentId | null,
): ReadonlyArray<ReadonlyArray<OrchestrationThreadShell>> {
  return useAtomValue(archivedShellsAtom(environmentId ?? ("" as EnvironmentId)));
}

/**
 * Asks for the shells `request` names while the calling screen is mounted.
 * `pending` is true until the first answer (or failure) arrives, so a screen
 * can wait before it calls a chat missing.
 */
export function useLazyThreadShells(
  environmentId: EnvironmentId | null,
  request: LazyThreadShellRequest | null,
): { readonly pending: boolean } {
  const key =
    environmentId !== null &&
    request !== null &&
    !("threadIds" in request && request.threadIds.length === 0)
      ? requestKey(request)
      : null;
  const setRequests = useAtomSet(lazyRequestsAtom(environmentId ?? ("" as EnvironmentId)));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds a counted entry in the shared lazy-request registry until unmount
  useEffect(() => {
    if (key === null) return;
    setRequests((current) => {
      const next = new Map(current);
      next.set(key, (next.get(key) ?? 0) + 1);
      return next;
    });
    return () => {
      setRequests((current) => {
        const next = new Map(current);
        const count = (next.get(key) ?? 0) - 1;
        if (count > 0) next.set(key, count);
        else next.delete(key);
        return next;
      });
    };
  }, [key, setRequests]);
  const query = useEnvironmentQuery(
    key === null || environmentId === null ? null : queryAtom(environmentId, key),
  );
  return { pending: key !== null && query.data === null && query.error === null };
}
