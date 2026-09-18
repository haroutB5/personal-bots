/**
 * Registers the server-owned browser with the PreviewAutomationBroker as an
 * in-process host, so the existing preview MCP tools drive it with no broker
 * transport changes. Every request is answered on its own fiber: `status`
 * must not queue behind a long navigate.
 */
import {
  type PreviewAutomationOperation,
  type PreviewAutomationResponse,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import { HostOperationError } from "./pageOperations.ts";
import { PersonalBrowser } from "./PersonalBrowser.ts";

export const SERVER_BROWSER_CLIENT_ID = "server-browser";

/** Recording is desktop-only; it is deliberately not advertised. */
export const SERVER_BROWSER_OPERATIONS: ReadonlyArray<PreviewAutomationOperation> = [
  "status",
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "waitFor",
  "resize",
  "setColorScheme",
];

export const toRemoteError = (
  cause: Cause.Cause<unknown>,
): NonNullable<PreviewAutomationResponse["error"]> => {
  const error = Cause.squash(cause);
  if (error instanceof HostOperationError) {
    return {
      _tag: error.tag,
      message: error.message,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    };
  }
  return {
    _tag: "PreviewAutomationExecutionError",
    message: error instanceof Error ? error.message : "Server browser operation failed.",
  };
};

/** First pause before re-registering, doubled per consecutive failed attempt. */
export const RECONNECT_INITIAL_DELAY_MS = 250;
/** Ceiling for the doubling backoff, so a broken broker cannot spin hot. */
export const RECONNECT_MAX_DELAY_MS = 5_000;

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const browser = yield* PersonalBrowser;
    const descriptor = yield* environment.getDescriptor;
    const inFlight = yield* FiberSet.make();

    /**
     * One registration, served until the broker ends the request stream.
     * Resolves to whether this connection did any work, which is what
     * distinguishes a healthy connection that was disconnected from a broker
     * that cannot keep a connection alive at all.
     */
    const serveConnection = Effect.gen(function* () {
      const requests = yield* broker.connect({
        clientId: SERVER_BROWSER_CLIENT_ID,
        environmentId: descriptor.environmentId,
        supportedOperations: [...SERVER_BROWSER_OPERATIONS],
        kind: "server",
      });
      // Scoped to this connection on purpose: the broker drops a response
      // carrying a superseded connection id, so an id must never outlive the
      // connection that issued it.
      let connectionId: string | null = null;
      let served = false;
      yield* requests.pipe(
        Stream.runForEach((event) => {
          if (event.type === "connected") {
            connectionId = event.connectionId;
            return Effect.void;
          }
          served = true;
          const replyConnectionId = connectionId ?? event.connectionId;
          const { request } = event;
          return FiberSet.run(
            inFlight,
            browser.handleAutomationRequest(request).pipe(
              Effect.exit,
              Effect.flatMap((exit) =>
                broker.respond({
                  clientId: SERVER_BROWSER_CLIENT_ID,
                  connectionId: replyConnectionId,
                  requestId: request.requestId,
                  ...(Exit.isSuccess(exit)
                    ? { ok: true, result: exit.value }
                    : { ok: false, error: toRemoteError(exit.cause) }),
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("Server browser could not answer a preview request.", { cause }),
              ),
            ),
          ).pipe(Effect.asVoid);
        }),
      );
      return served;
    });

    /**
     * The broker treats one unanswered request as a dead client: it shuts the
     * connection's queue down, which ends the stream above. Registering only
     * once meant a single slow operation (a Chrome start that outran the 15s
     * preview timeout) took the server browser out of every bot until the
     * process restarted. Re-register instead, so a timeout costs one operation.
     */
    yield* Effect.gen(function* () {
      let delayMs = RECONNECT_INITIAL_DELAY_MS;
      for (;;) {
        const exit = yield* Effect.exit(serveConnection);
        const served = Exit.isSuccess(exit) && exit.value;
        // A disconnect surfaces as an interrupt of the stream's own fiber, so
        // the cause cannot tell shutdown apart from a broker disconnect. The
        // sleep below is the discriminator: it is interruptible, so a closing
        // layer scope ends the loop here instead of reconnecting.
        yield* Effect.sleep(Duration.millis(delayMs));
        yield* Effect.logWarning("Server browser is re-registering with the preview broker.", {
          delayMs,
          servedRequests: served,
          ...(Exit.isFailure(exit) ? { cause: exit.cause } : {}),
        });
        delayMs = served
          ? RECONNECT_INITIAL_DELAY_MS
          : Math.min(delayMs * 2, RECONNECT_MAX_DELAY_MS);
      }
    }).pipe(Effect.forkScoped);
  }),
);
