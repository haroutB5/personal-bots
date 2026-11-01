import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/unstable/socket/Socket";
import { HttpServerRequest } from "effect/unstable/http";
import type { AuthSessionId } from "@t3tools/contracts";

import type * as SessionStore from "./SessionStore.ts";

export const SESSION_REVOKED_CLOSE_CODE = 4401;
export const SESSION_REVOKED_CLOSE_REASON = "session_revoked";

export const serveUntilSessionRevoked = <A, E, R>(input: {
  readonly sessions: SessionStore.SessionStore["Service"];
  readonly sessionId: AuthSessionId;
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly serve: Effect.Effect<A, E, R>;
}): Effect.Effect<A, E, Exclude<R, HttpServerRequest.HttpServerRequest> | Scope.Scope> =>
  Effect.gen(function* () {
    const upgraded = yield* Deferred.make<Socket.Socket>();
    const trackedRequest = Object.create(input.request, {
      upgrade: {
        value: input.request.upgrade.pipe(
          Effect.tap((socket) => Deferred.succeed(upgraded, socket)),
        ),
      },
    }) as HttpServerRequest.HttpServerRequest;
    const closeOnRevoke = input.sessions.awaitRevoked(input.sessionId).pipe(
      Effect.andThen(Deferred.await(upgraded)),
      Effect.flatMap((socket) =>
        Effect.scoped(
          socket.writer.pipe(
            Effect.flatMap((writer) =>
              writer.write(
                new Socket.CloseEvent(SESSION_REVOKED_CLOSE_CODE, SESSION_REVOKED_CLOSE_REASON),
              ),
            ),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to close the socket of a revoked session.").pipe(
          Effect.annotateLogs({ sessionId: input.sessionId, cause }),
        ),
      ),
      Effect.andThen(Effect.never),
    );
    return yield* Effect.raceFirst(
      input.serve.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, trackedRequest)),
      closeOnRevoke,
    );
  });
