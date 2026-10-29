import { useAtomSet } from "@effect/atom-react";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
  PersonalBotThreadShellsInput,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { perfOptimizationOn } from "../features/personal/perfFlags";
import { useEnvironmentQuery } from "./query";

/**
 * The slim shell (personalShellSlim.ts on the server) leaves out the bot
 * chats the owner archived. The screens that show them ask for them here:
 * a bot's chat list asks for that bot's chats, an open archived chat for
 * itself, search for the chats its hits name. Each answer is merged into the
 * environment snapshot (environmentSnapshotAtom), so every thread-shell
 * reader sees them like any other thread, for as long as a screen asks.
 *
 * Kill switch: `shell-omit-archived` (perfFlags.ts) loads the full shell at
 * connect and turns these requests off.
 */
export function shellOmitArchivedOn(): boolean {
  return perfOptimizationOn("shell-omit-archived");
}

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

/**
 * `base` with the asked-for shells appended. A thread the base already holds
 * keeps its base shell, which the live stream keeps current.
 */
export function mergeLazyThreadShells(
  base: OrchestrationShellSnapshot,
  extra: ReadonlyArray<ReadonlyArray<OrchestrationThreadShell>>,
): OrchestrationShellSnapshot {
  if (extra.every((threads) => threads.length === 0)) return base;
  const seen = new Set<string>(base.threads.map((thread) => thread.id));
  const appended: OrchestrationThreadShell[] = [];
  for (const threads of extra) {
    for (const thread of threads) {
      if (seen.has(thread.id)) continue;
      seen.add(thread.id);
      appended.push(thread);
    }
  }
  return appended.length === 0 ? base : { ...base, threads: [...base.threads, ...appended] };
}

/** Wraps a snapshot atom family so it carries the asked-for shells too. */
export function withLazyThreadShells(
  baseSnapshotAtom: (environmentId: EnvironmentId) => Atom.Atom<OrchestrationShellSnapshot | null>,
) {
  return Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): OrchestrationShellSnapshot | null => {
      const base = get(baseSnapshotAtom(environmentId));
      if (base === null) return null;
      const requests = get(lazyRequestsAtom(environmentId));
      if (requests.size === 0) return base;
      const extra: Array<ReadonlyArray<OrchestrationThreadShell>> = [];
      for (const key of requests.keys()) {
        const value = AsyncResult.value(get(queryAtom(environmentId, key)));
        if (Option.isSome(value)) extra.push(value.value.threads);
      }
      return mergeLazyThreadShells(base, extra);
    }).pipe(Atom.withLabel(`environment-snapshot-with-lazy:${environmentId}`)),
  );
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
  const on = shellOmitArchivedOn();
  const key =
    on &&
    environmentId !== null &&
    request !== null &&
    !("threadIds" in request && request.threadIds.length === 0)
      ? requestKey(request)
      : null;
  const setRequests = useAtomSet(lazyRequestsAtom(environmentId ?? ("" as EnvironmentId)));
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
