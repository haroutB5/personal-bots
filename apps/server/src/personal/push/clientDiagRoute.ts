/**
 * `POST /api/personal/client-diag`: one line in the server log per
 * notification tap, sent by the service worker and the page (public/sw.js,
 * web features/personal/serviceWorker.ts). A tap that fails on the phone
 * leaves no other trace, so these lines say which delivery route was taken,
 * how many windows the worker saw and whether the page answered.
 *
 * Deliberately small: signed-in callers only (session cookie, like the other
 * personal routes), JSON only (a cross-site form cannot send it without a
 * preflight), 4KB bodies, 30 lines a minute, and the record is re-serialised
 * and capped before it reaches the log. It never touches storage.
 */
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
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
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";

export const PERSONAL_CLIENT_DIAG_PATH = "/api/personal/client-diag";
export const CLIENT_DIAG_MAX_BYTES = 4096;
export const CLIENT_DIAG_MAX_PER_MINUTE = 30;
/** What reaches the log line, after re-serialisation. */
export const CLIENT_DIAG_LOGGED_CHARS = 1500;

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;
const reply = (status: number, body: string) =>
  HttpServerResponse.text(body, { status, headers: HEADERS });

const authenticate = Effect.gen(function* () {
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
  if (!session.scopes.includes(AuthOrchestrationReadScope)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
  }
  return session;
});

/** The record as it will be logged, or null when it is not a JSON object. */
export function clientDiagLine(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  // Re-serialised: control characters come out escaped, so one tap is one line.
  const line = JSON.stringify(parsed);
  return line.length > CLIENT_DIAG_LOGGED_CHARS
    ? `${line.slice(0, CLIENT_DIAG_LOGGED_CHARS)}...`
    : line;
}

export interface ClientDiagRouteOptions {
  /** Where accepted lines go; the server log by default. */
  readonly record?: (line: string) => Effect.Effect<void>;
}

export const makePersonalClientDiagRouteLayer = (options: ClientDiagRouteOptions = {}) => {
  const record = options.record ?? ((line: string) => Effect.logInfo(`client-diag ${line}`));
  let windowStart = 0;
  let windowCount = 0;
  return HttpRouter.add(
    "POST",
    PERSONAL_CLIENT_DIAG_PATH,
    Effect.gen(function* () {
      yield* authenticate;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const contentType = request.headers["content-type"] ?? "";
      if (!/^application\/json\b/i.test(contentType)) return reply(415, "Unsupported Media Type");
      const declared = Number(request.headers["content-length"]);
      if (Number.isFinite(declared) && declared > CLIENT_DIAG_MAX_BYTES) {
        return reply(413, "Payload Too Large");
      }

      const now = yield* Clock.currentTimeMillis;
      if (now - windowStart >= 60_000) {
        windowStart = now;
        windowCount = 0;
      }
      if (windowCount >= CLIENT_DIAG_MAX_PER_MINUTE) return reply(429, "Too Many Requests");
      windowCount += 1;

      let received = 0;
      const collected = yield* collectUint8StreamText({
        stream: request.stream.pipe(
          Stream.takeUntil((chunk) => {
            received += chunk.byteLength;
            return received > CLIENT_DIAG_MAX_BYTES;
          }),
        ),
        maxBytes: CLIENT_DIAG_MAX_BYTES + 1,
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => null),
      );
      if (collected === null) return reply(400, "Bad Request");
      if (collected.bytes > CLIENT_DIAG_MAX_BYTES) return reply(413, "Payload Too Large");
      const line = clientDiagLine(collected.text);
      if (line === null) return reply(400, "Bad Request");
      yield* record(line);
      return HttpServerResponse.empty({ status: 204, headers: HEADERS });
    }).pipe(
      Effect.catchTags({
        EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
        EnvironmentInternalError: HttpServerRespondable.toResponse,
        EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      }),
    ),
  );
};

export const personalClientDiagRouteLayer = makePersonalClientDiagRouteLayer();
