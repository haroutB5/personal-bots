import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/**
 * Calls `listener` with whether the connection is up: now, and again on each change. The returned
 * function stops it. Each call to it is one listener, so a screen that subscribes again after a
 * session change must stop the old one.
 */
export function subscribeConnectedPhase<State extends { readonly phase: string }>(
  stateRef: SubscriptionRef.SubscriptionRef<State>,
  listener: (connected: boolean) => void,
): () => void {
  const fiber = Effect.runFork(
    Stream.runForEach(SubscriptionRef.changes(stateRef), (next) =>
      Effect.sync(() => listener(next.phase === "connected")),
    ),
  );
  return () => {
    void Effect.runPromise(Fiber.interrupt(fiber));
  };
}
