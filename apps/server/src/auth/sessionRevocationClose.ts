import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import { HttpServerRequest } from "effect/unstable/http";
import type { AuthSessionId } from "@t3tools/contracts";

import * as SessionStore from "./SessionStore.ts";

export const SESSION_REVOKED_CLOSE_CODE = 4401;
export const SESSION_REVOKED_CLOSE_REASON = "session_revoked";

const trackUpgrade = (
  request: HttpServerRequest.HttpServerRequest,
  upgraded: Deferred.Deferred<Socket.Socket>,
): HttpServerRequest.HttpServerRequest =>
  Object.create(request, {
    upgrade: {
      value: request.upgrade.pipe(Effect.tap((socket) => Deferred.succeed(upgraded, socket))),
    },
    modify: {
      value: (options: Parameters<HttpServerRequest.HttpServerRequest["modify"]>[0]) =>
        trackUpgrade(request.modify(options), upgraded),
    },
  });

/**
 * Runs `serve` against a request whose WebSocket upgrade is watched, and closes
 * that socket with 4401 as soon as `sessionId` is revoked. Every socket route that
 * authenticates a session once at upgrade goes through this.
 */
export const serveUntilSessionRevoked = <A, E, R>(input: {
  readonly sessionId: AuthSessionId;
  readonly serve: Effect.Effect<A, E, R>;
}): Effect.Effect<
  A,
  E,
  R | SessionStore.SessionStore | HttpServerRequest.HttpServerRequest | Scope.Scope
> =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const upgraded = yield* Deferred.make<Socket.Socket>();
    const closeOnRevoke = sessions.awaitRevoked(input.sessionId).pipe(
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
      input.serve.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, trackUpgrade(request, upgraded)),
      ),
      closeOnRevoke,
    );
  });

/**
 * Ends `stream` as soon as `sessionId` is revoked. The HTTP counterpart of
 * `serveUntilSessionRevoked`: a response body that was authenticated once when
 * it opened stops flowing, and finishing the body releases whatever the stream
 * holds open, such as an upstream connection.
 */
export const endStreamWhenSessionRevoked = <A, E, R>(input: {
  readonly sessionId: AuthSessionId;
  readonly stream: Stream.Stream<A, E, R>;
}): Effect.Effect<Stream.Stream<A, E, R>, never, SessionStore.SessionStore> =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    return input.stream.pipe(Stream.interruptWhen(sessions.awaitRevoked(input.sessionId)));
  });
