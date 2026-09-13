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

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const browser = yield* PersonalBrowser;
    const descriptor = yield* environment.getDescriptor;
    const inFlight = yield* FiberSet.make();
    const requests = yield* broker.connect({
      clientId: SERVER_BROWSER_CLIENT_ID,
      environmentId: descriptor.environmentId,
      supportedOperations: [...SERVER_BROWSER_OPERATIONS],
      kind: "server",
    });
    let connectionId: string | null = null;
    yield* requests.pipe(
      Stream.runForEach((event) => {
        if (event.type === "connected") {
          connectionId = event.connectionId;
          return Effect.void;
        }
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
      Effect.forkScoped,
    );
  }),
);
