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
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
        const write = yield* socket.writer;
        const viewer = yield* browser.attachViewer({
          sessionId: session.sessionId,
          canOperate: session.scopes.includes(AuthOrchestrationOperateScope),
        });
        const outbound = Stream.fromQueue(viewer.outbox).pipe(Stream.runForEach(write));
        const inbound = socket.runRaw((data) =>
          typeof data === "string" ? browser.handleViewerMessage(viewer, data) : Effect.void,
        );
        // Whichever side ends first tears the other down via scope teardown.
        yield* Effect.raceFirst(outbound, inbound);
      }),
    ).pipe(Effect.catchCause(() => Effect.void));
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
