import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import {
  type AuthEnvironmentScope,
  type AuthSessionState,
  type EnvironmentId,
  sessionGrantsScope,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";

export const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);
export const environmentSessionStatesAtom = environmentAtomList(
  "web-environment-session-states",
  environmentSession.sessionStateAtom,
);

const EMPTY_SESSION_STATE_ATOM = Atom.make(AsyncResult.initial<AuthSessionState>());

export function useEnvironmentScope(
  environmentId: EnvironmentId | null,
  scope: AuthEnvironmentScope,
): boolean {
  // Select the grant: every revalidation emits a new result, and most consumers are list rows.
  return useAtomValue(
    environmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateAtom(environmentId),
    (result) => sessionHasScope(result, scope),
  );
}

export function sessionHasScope(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
  scope: AuthEnvironmentScope,
): boolean {
  const session = AsyncResult.getOrElse(result, () => null);
  return result._tag !== "Failure" && session !== null && sessionGrantsScope(session, scope);
}

const environmentsWithScopeAtom = Atom.family((key: string) => {
  const [scope, idsKey = ""] = key.split(/\n(.*)/s) as [AuthEnvironmentScope, string?];
  const ids = idsKey === "" ? [] : (idsKey.split("\n") as EnvironmentId[]);
  const statesAtom = environmentSessionStatesAtom(idsKey);
  return Atom.make((get) => {
    const states = get(statesAtom);
    return new Set(ids.filter((_, index) => sessionHasScope(states[index]!, scope)));
  }).pipe(Atom.withLabel(`web-environments-with-scope:${key}`));
});

export function useEnvironmentsWithScope(
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
  scope: AuthEnvironmentScope,
): ReadonlySet<EnvironmentId> {
  return useAtomValue(
    environmentsWithScopeAtom(
      `${scope}\n${environmentIdsKey(environments.map(({ environmentId }) => environmentId))}`,
    ),
  );
}

export function readEnvironmentScope(
  environmentId: EnvironmentId,
  scope: AuthEnvironmentScope,
): boolean {
  return sessionHasScope(
    appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId)),
    scope,
  );
}

const EMPTY_PREPARED_CONNECTION_ATOM = Atom.make(Option.none()).pipe(
  Atom.withLabel("web-prepared-connection:empty"),
);

export function usePreparedConnection(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null
      ? EMPTY_PREPARED_CONNECTION_ATOM
      : environmentSession.preparedConnectionValueAtom(environmentId),
  );
}

/** Null until some consumer mounts the atom. Use awaitPreparedConnection where null is a failure. */
export function readPreparedConnection(environmentId: EnvironmentId) {
  return Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
}

type PreparedConnection = NonNullable<ReturnType<typeof readPreparedConnection>>;

const PREPARED_CONNECTION_WAIT_MS = 10_000;

/**
 * The prepared connection, mounting the atom and waiting when no one else has.
 * Subscribing starts the stream that publishes it, so this answers from a screen
 * with nothing else bound to the environment. Null means the wait elapsed.
 */
export function awaitPreparedConnection(
  environmentId: EnvironmentId,
  options: { readonly timeoutMs?: number } = {},
): Promise<PreparedConnection | null> {
  const atom = environmentSession.preparedConnectionValueAtom(environmentId);
  const mounted = Option.getOrNull(appAtomRegistry.get(atom));
  if (mounted !== null) return Promise.resolve(mounted);
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = (connection: PreparedConnection | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      // Undefined when subscribe called back before returning; released below.
      unsubscribe?.();
      resolve(connection);
    };
    unsubscribe = appAtomRegistry.subscribe(
      atom,
      (value) => {
        const connection = Option.getOrNull(value);
        if (connection !== null) finish(connection);
      },
      { immediate: true },
    );
    if (settled) {
      unsubscribe();
      return;
    }
    timer = setTimeout(() => finish(null), options.timeoutMs ?? PREPARED_CONNECTION_WAIT_MS);
  });
}

/** data survives SWR revalidation; isPending applies only before first resolve. */
export function useEnvironmentSessionState(environmentId: EnvironmentId | null) {
  const result = useAtomValue(
    environmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateAtom(environmentId),
  );
  return {
    data: AsyncResult.getOrElse(result, () => null),
    hasError: result._tag === "Failure",
    isPending: result.waiting,
  };
}
