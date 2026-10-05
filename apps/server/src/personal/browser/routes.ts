/**
 * HTTP surface of the personal browser: the live viewport socket and artifact
 * downloads. `<img>`/WebSocket cannot send auth headers, so both authenticate
 * like the `/ws` upgrade (session cookie, or a short-lived `wsTicket` minted
 * over authenticated HTTP). No CORS changes: same-origin or ticketed only.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  PERSONAL_BROWSER_FILES_ROUTE_PREFIX,
  PERSONAL_BROWSER_STREAM_PATH,
  PersonalBrowserInputMessage,
  PersonalBrowserViewerMessage,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";
import { PersonalBrowser } from "./PersonalBrowser.ts";
import { InputLine } from "./inputLine.ts";
import { runViewerFrames } from "./viewerFlow.ts";

const FRAME_ACKS_NOTICE = Schema.encodeSync(Schema.fromJsonString(PersonalBrowserViewerMessage))({
  _tag: "FrameAcks",
});

const STREAM_STATS_WANTED_NOTICE = Schema.encodeSync(
  Schema.fromJsonString(PersonalBrowserViewerMessage),
)({ _tag: "StreamStatsWanted" });

const SCROLL_END_WANTED_NOTICE = Schema.encodeSync(
  Schema.fromJsonString(PersonalBrowserViewerMessage),
)({ _tag: "ScrollEndWanted" });

/** What the phone sends for every frame, exactly as its client encodes it. */
const FRAME_ACK_TEXT = Schema.encodeSync(Schema.fromJsonString(PersonalBrowserInputMessage))({
  _tag: "FrameAck",
});

/**
 * Kill switch: `T3CODE_PERSONAL_BROWSER_ACK_FASTPATH=off` queues acknowledgements
 * behind the inputs ahead of them again, as in 1.60.31 and 1.60.32.
 */
const ackFastPathOn = () => process.env.T3CODE_PERSONAL_BROWSER_ACK_FASTPATH?.trim() !== "off";

/**
 * Kill switch: `T3CODE_PERSONAL_BROWSER_WHEEL_COALESCE=off` stops merging queued wheel
 * messages (see inputLine.ts).
 */
const wheelCoalesceOn = () => process.env.T3CODE_PERSONAL_BROWSER_WHEEL_COALESCE?.trim() !== "off";

/**
 * Bytes the viewer's TCP socket has accepted but not yet handed to the
 * network. The Effect socket writer sends without a completion callback, so
 * this is the only sign that the link is slower than the frames being sent.
 */
const socketBacklogBytes = (source: unknown): (() => number) => {
  const socket = (source as { readonly socket?: { readonly writableLength?: unknown } } | null)
    ?.socket;
  return () => (typeof socket?.writableLength === "number" ? socket.writableLength : 0);
};

/**
 * Authenticates a personal HTTP route the way the `/ws` upgrade does (session
 * cookie or `wsTicket`) and requires `requiredScope`. Shared with the desktop
 * live view.
 */
export const authenticatePersonalRoute = (requiredScope: AuthEnvironmentScope) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(
          EnvironmentAuth.serverAuthCredentialReason(error),
          EnvironmentAuth.serverAuthDpopFailureReason(error),
        ),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(requiredScope)) {
      return yield* failEnvironmentScopeRequired(requiredScope);
    }
    return session;
  });

export const personalRouteAuthResponses = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

/**
 * Viewers need read scope; input additionally needs operate scope and human
 * control (checked per message). Frames flow only while a viewer is attached.
 */
export const personalBrowserStreamRouteLayer = HttpRouter.add(
  "GET",
  PERSONAL_BROWSER_STREAM_PATH,
  Effect.gen(function* () {
    // Authenticate before anything else so an anonymous probe learns nothing.
    const session = yield* authenticatePersonalRoute(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers.upgrade?.toLowerCase() !== "websocket") {
      return HttpServerResponse.text("Upgrade Required", { status: 426 });
    }
    const browser = yield* PersonalBrowser;
    const socket = yield* request.upgrade;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { write } = yield* socket.writer;
        const viewer = yield* browser.attachViewer({
          sessionId: session.sessionId,
          canOperate: session.scopes.includes(AuthOrchestrationOperateScope),
        });
        // Control messages go out at once and are never dropped. Frames go through
        // the viewer's flow control: only the newest waits, paced by the link.
        viewer.flow.setBacklogProbe(socketBacklogBytes(request.source));
        const control = Stream.fromQueue(viewer.outbox).pipe(Stream.runForEach(write));
        // The writer waits for the reader, so the notice has to go out from here.
        const frames = Effect.andThen(
          write(FRAME_ACKS_NOTICE).pipe(
            Effect.andThen(
              viewer.telemetry === null ? Effect.void : write(STREAM_STATS_WANTED_NOTICE),
            ),
            Effect.andThen(
              viewer.scrollEndHint === true ? write(SCROLL_END_WANTED_NOTICE) : Effect.void,
            ),
          ),
          runViewerFrames(viewer.flow, write),
        );
        const outbound = Effect.raceFirst(control, frames);
        // Inputs are handled one at a time, in order, by a worker; the reader only
        // queues them. A frame acknowledgement must not wait behind a scroll that is
        // still being dispatched to Chrome (it paces the next frame), so the reader
        // takes it straight away, ahead of the queue.
        const line = new InputLine({ coalesceWheels: wheelCoalesceOn() });
        const wake = yield* Queue.sliding<void>(1);
        const fastAcks = ackFastPathOn();
        const reader = Effect.gen(function* () {
          const { pull } = yield* socket.reader;
          while (true) {
            for (const data of yield* pull) {
              if (typeof data !== "string") continue;
              if (fastAcks && data === FRAME_ACK_TEXT) {
                viewer.flow.acknowledge();
                continue;
              }
              if (line.push(data, performance.now())) viewer.telemetry?.wheelMerged();
              viewer.telemetry?.inputQueued(line.size);
              Queue.offerUnsafe(wake, undefined);
            }
          }
        });
        const worker = Effect.forever(
          Queue.take(wake).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                for (let next = line.take(); next !== undefined; next = line.take()) {
                  yield* browser.handleViewerMessage(viewer, next.raw, next.arrivedAt);
                }
              }),
            ),
          ),
        );
        const inbound = Effect.raceFirst(reader, worker);
        // Whichever side ends first tears the other down via scope teardown.
        yield* Effect.raceFirst(outbound, inbound);
      }),
    ).pipe(Effect.ignoreCause);
    return HttpServerResponse.empty();
  }).pipe(Effect.catchTags(personalRouteAuthResponses)),
);

/** `GET <prefix>/<fileId>`: ids come from `personalBrowser.listFiles`, never paths. */
export const personalBrowserFilesRouteLayer = HttpRouter.add(
  "GET",
  `${PERSONAL_BROWSER_FILES_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    yield* authenticatePersonalRoute(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const fileId = url.value.pathname.slice(`${PERSONAL_BROWSER_FILES_ROUTE_PREFIX}/`.length);
    if (!/^[a-f0-9]{32}$/.test(fileId))
      return HttpServerResponse.text("Not Found", { status: 404 });
    const browser = yield* PersonalBrowser;
    const file = yield* browser.resolveFile(fileId).pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(file)) return HttpServerResponse.text("Not Found", { status: 404 });
    return yield* HttpServerResponse.file(file.value.path, {
      headers: {
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.value.name)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }).pipe(Effect.catchTags(personalRouteAuthResponses)),
);
