// @effect-diagnostics globalTimers:off - the polling helper waits on plain timers
import { expect, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpServerError, HttpServerRequest } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import {
  SESSION_REVOKED_CLOSE_CODE,
  endStreamWhenSessionRevoked,
  serveUntilSessionRevoked,
} from "./sessionRevocationClose.ts";
import { SessionStore } from "./SessionStore.ts";

const SESSION_ID = AuthSessionId.make("session-1");

const makeFixture = () => {
  const closes: Array<Socket.CloseEvent> = [];
  let destroyed = 0;
  const socket = {
    writer: Effect.succeed({
      write: (event: unknown) =>
        Effect.sync(() => {
          if (Socket.isCloseEvent(event)) closes.push(event);
        }),
    }),
  } as unknown as Socket.Socket;
  // Mirrors ServerRequestImpl: `modify` builds a fresh request from the original upgrade effect.
  const request = {
    upgrade: Effect.succeed(socket),
    modify: () => request,
    source: { socket: { destroy: () => void destroyed++ } },
  } as unknown as HttpServerRequest.HttpServerRequest;
  const revoked = Deferred.makeUnsafe<void>();
  const sessions = {
    awaitRevoked: () => Deferred.await(revoked),
  } as unknown as SessionStore["Service"];
  const serve = (
    body: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<unknown, HttpServerError.HttpServerError>,
  ) =>
    serveUntilSessionRevoked({
      sessionId: SESSION_ID,
      serve: Effect.flatMap(HttpServerRequest.HttpServerRequest, body),
    }).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provideService(SessionStore, sessions),
      Effect.scoped,
    );
  const closed = Effect.promise(async () => {
    const until = performance.now() + 2000;
    while (closes.length === 0 && performance.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return closes[0];
  });
  return { closes, revoked, serve, closed, destroyed: () => destroyed };
};

it.effect("closes the upgraded socket with 4401 when the session is revoked", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    const fiber = yield* Effect.forkChild(
      fixture.serve((request) => Effect.andThen(request.upgrade, Effect.never)),
    );
    yield* Deferred.succeed(fixture.revoked, undefined);
    const close = yield* fixture.closed;
    expect(close?.code).toBe(SESSION_REVOKED_CLOSE_CODE);
    expect(close?.reason).toBe("session_revoked");
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("stops serving the moment the session is revoked", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    let serving = true;
    const fiber = yield* Effect.forkChild(
      fixture.serve((request) =>
        request.upgrade.pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.sync(() => void (serving = false))),
        ),
      ),
    );
    yield* Effect.yieldNow;
    expect(serving).toBe(true);
    yield* Deferred.succeed(fixture.revoked, undefined);
    yield* fixture.closed;
    expect(serving).toBe(false);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("destroys the socket of a client that never answers the close frame", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    const fiber = yield* Effect.forkChild(
      fixture.serve((request) => Effect.andThen(request.upgrade, Effect.never)),
    );
    yield* Deferred.succeed(fixture.revoked, undefined);
    yield* fixture.closed;
    yield* TestClock.adjust("100 millis");
    expect(fixture.destroyed()).toBe(0);
    yield* TestClock.adjust("1 second");
    expect(fixture.destroyed()).toBe(1);
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("leaves the socket to the close handshake when the client answers within the grace", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    const fiber = yield* Effect.forkChild(
      fixture.serve((request) => Effect.andThen(request.upgrade, Effect.never)),
    );
    yield* Deferred.succeed(fixture.revoked, undefined);
    yield* fixture.closed;
    yield* Fiber.interrupt(fiber);
    yield* TestClock.adjust("2 seconds");
    expect(fixture.destroyed()).toBe(0);
  }),
);

it.effect("still closes the socket when serve calls request.modify before upgrading", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    const fiber = yield* Effect.forkChild(
      fixture.serve((request) =>
        Effect.andThen(request.modify({ url: "/rewritten" }).upgrade, Effect.never),
      ),
    );
    yield* Deferred.succeed(fixture.revoked, undefined);
    const close = yield* fixture.closed;
    expect(close?.code).toBe(SESSION_REVOKED_CLOSE_CODE);
    expect(close?.reason).toBe("session_revoked");
    yield* Fiber.interrupt(fiber);
  }),
);

it.effect("ends a stream with the frames it delivered once its session is revoked", () =>
  Effect.gen(function* () {
    const revoked = Deferred.makeUnsafe<void>();
    const sessions = {
      awaitRevoked: () => Deferred.await(revoked),
    } as unknown as SessionStore["Service"];
    const received: Array<number> = [];
    const body = yield* endStreamWhenSessionRevoked({
      sessionId: SESSION_ID,
      stream: Stream.make(1, 2).pipe(Stream.concat(Stream.never)),
    }).pipe(Effect.provideService(SessionStore, sessions));
    const fiber = yield* Effect.forkChild(
      body.pipe(Stream.runForEach((frame) => Effect.sync(() => received.push(frame)))),
    );
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(received).toEqual([1, 2]);
    yield* Deferred.succeed(revoked, undefined);
    yield* Fiber.join(fiber);
  }),
);
