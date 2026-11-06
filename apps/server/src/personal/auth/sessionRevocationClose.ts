import type { AuthSessionId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

/** B1 stub. Serves without closing on revoke until C11 restores auth/sessionRevocationClose.ts. */
export const serveUntilSessionRevoked = <A, E, R>(input: {
  readonly sessionId: AuthSessionId;
  readonly serve: Effect.Effect<A, E, R>;
}): Effect.Effect<A, E, R> => input.serve;
