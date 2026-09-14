import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);

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

/**
 * The prepared connection *if some other consumer already keeps the atom
 * mounted*. `preparedConnectionAtom` is a stream-backed atom whose initial
 * value is `None`, and the stream that fills it only runs while the atom has a
 * subscriber. A bare `registry.get` therefore reads `None` and keeps reading
 * `None` for as long as nothing in the mounted tree happens to subscribe.
 * Prefer `awaitPreparedConnection` anywhere a null answer is a user-visible
 * failure rather than a render-time placeholder.
 */
export function readPreparedConnection(environmentId: EnvironmentId) {
  return Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
}

export type PreparedConnection = NonNullable<ReturnType<typeof readPreparedConnection>>;

const PREPARED_CONNECTION_WAIT_MS = 10_000;

/**
 * The prepared connection, mounting the atom and waiting when no one else has.
 *
 * Subscribing is what starts the supervisor stream that publishes the prepared
 * connection, so this answers even from a screen that renders nothing else
 * bound to the environment. Resolves `null` only when the wait elapses, which
 * really does mean "not connected".
 */
export function awaitPreparedConnection(
  environmentId: EnvironmentId,
  options: { readonly timeoutMs?: number } = {},
): Promise<PreparedConnection | null> {
  const atom = environmentSession.preparedConnectionValueAtom(environmentId);
  const mounted = Option.getOrNull(appAtomRegistry.get(atom));
  if (mounted !== null) {
    return Promise.resolve(mounted);
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = (connection: PreparedConnection | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      // `undefined` when `subscribe` called back before returning; the caller
      // below releases the subscription in that case.
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

/**
 * This client's authenticated session on one environment, as reported by that
 * environment's `/api/auth/session` endpoint. `data` stays populated across
 * SWR revalidations; `isPending` is only meaningful before the first resolve.
 */
export function useEnvironmentSessionState(environmentId: EnvironmentId) {
  const result = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    hasError: result._tag === "Failure",
    isPending: result.waiting,
  };
}
