/**
 * The live view socket of the user's PC (the app's Computer > Desktop). It
 * authenticates like the browser viewport (session cookie or a short-lived
 * `wsTicket`) and needs operate scope: the whole screen shows more than the
 * bots' browser does, so it asks for the same scope as Stop.
 *
 * View only by construction: the socket understands Ack and Viewport and
 * nothing else, so no message can reach the PC's mouse or keyboard.
 */
import {
  AuthOrchestrationOperateScope,
  PERSONAL_DESKTOP_STREAM_PATH,
  PersonalDesktopViewInput,
  PersonalDesktopViewMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { authenticatePersonalRoute, personalRouteAuthResponses } from "../browser/routes.ts";
import type { LiveViewer } from "./DesktopLiveView.ts";
import { PersonalDesktop } from "./PersonalDesktop.ts";

const decodeInput = Schema.decodeUnknownOption(Schema.fromJsonString(PersonalDesktopViewInput));
const encodeMessage = Schema.encodeSync(Schema.fromJsonString(PersonalDesktopViewMessage));

/** Applies one client message; anything else is ignored. */
export function handleDesktopViewMessage(viewer: LiveViewer, raw: string): void {
  const message = decodeInput(raw);
  if (Option.isNone(message)) return;
  if (message.value._tag === "Ack") viewer.ack();
  else viewer.setViewport(message.value.width, message.value.height);
}

export const personalDesktopStreamRouteLayer = HttpRouter.add(
  "GET",
  PERSONAL_DESKTOP_STREAM_PATH,
  Effect.gen(function* () {
    // Authenticate before anything else so an anonymous probe learns nothing.
    yield* authenticatePersonalRoute(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers.upgrade?.toLowerCase() !== "websocket") {
      return HttpServerResponse.text("Upgrade Required", { status: 426 });
    }
    const desktop = yield* PersonalDesktop;
    const socket = yield* request.upgrade;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const write = yield* socket.writer;
        // Sliding: with one frame in flight it never holds more than a frame
        // and a state line, and a stuck socket drops rather than grows.
        const outbox = yield* Queue.sliding<Uint8Array | string>(4);
        const viewer = yield* desktop.watch({
          frame: (bytes) => {
            Queue.offerUnsafe(outbox, bytes);
          },
          state: (state, detail) => {
            Queue.offerUnsafe(
              outbox,
              encodeMessage({
                _tag: "ViewState",
                state,
                ...(detail === undefined ? {} : { detail }),
              }),
            );
          },
        });
        if (viewer === null) {
          yield* write(
            encodeMessage({
              _tag: "ViewState",
              state: "unavailable",
              detail: "The live view only works when the bots server runs on Windows.",
            }),
          );
          return;
        }
        const outbound = Stream.fromQueue(outbox).pipe(Stream.runForEach(write));
        const inbound = socket.runRaw((data) =>
          typeof data === "string"
            ? Effect.sync(() => handleDesktopViewMessage(viewer, data))
            : Effect.void,
        );
        // Whichever side ends first tears the other down; the scope detaches
        // the viewer, which stops its captures.
        yield* Effect.raceFirst(outbound, inbound);
      }),
    ).pipe(Effect.catchCause(() => Effect.void));
    return HttpServerResponse.empty();
  }).pipe(Effect.catchTags(personalRouteAuthResponses)),
);
