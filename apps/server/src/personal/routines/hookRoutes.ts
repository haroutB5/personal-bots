/**
 * The one unauthenticated route in the app: `POST /api/personal/hooks/<token>`.
 *
 * External services (GitHub, Slack, a home-automation box) cannot present our
 * session cookie or a DPoP proof, so the URL-embedded token is the whole
 * credential. That forces the rest of the design:
 *
 *  - the token is 32 random bytes and is compared in constant time
 *    (`PersonalRoutineService.fireEvent`), so the endpoint cannot be used as an
 *    oracle to walk a token out one character at a time;
 *  - every failure answers with a fixed, generic string. A caller never learns
 *    a routine title, a bot name, or whether a token exists but is paused;
 *  - the body is capped at 64KB and read through a bounded collector, so an
 *    unknown token can never make the server buffer a large upload;
 *  - one fire per token per 30s. Excess is refused with 429 and dropped, never
 *    queued, so a webhook storm cannot spawn a queue of bot turns.
 */
import {
  PERSONAL_ROUTINE_EVENT_PAYLOAD_MAX_BYTES,
  PERSONAL_ROUTINE_HOOK_ROUTE_PREFIX,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { PersonalRoutineService } from "./PersonalRoutineService.ts";

/** No caching, no sniffing, and no hint of the app behind it. */
const HOOK_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

const hookResponse = (status: number, body: string, headers?: Record<string, string>) =>
  HttpServerResponse.text(body, { status, headers: { ...HOOK_HEADERS, ...headers } });

const tokenOf = (pathname: string) =>
  decodeURIComponent(pathname.slice(`${PERSONAL_ROUTINE_HOOK_ROUTE_PREFIX}/`.length));

export const personalRoutineHookRouteLayer = HttpRouter.add(
  "POST",
  `${PERSONAL_ROUTINE_HOOK_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return hookResponse(400, "Bad Request");
    const hookToken = tokenOf(url.value.pathname);
    if (hookToken.length === 0) return hookResponse(404, "Not Found");

    // A declared oversize body is refused before a byte is read.
    const declaredLength = Number(request.headers["content-length"]);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > PERSONAL_ROUTINE_EVENT_PAYLOAD_MAX_BYTES
    ) {
      return hookResponse(413, "Payload Too Large");
    }
    // One byte over the cap is enough to know it is over the cap.
    const collected = yield* collectUint8StreamText({
      stream: request.stream,
      maxBytes: PERSONAL_ROUTINE_EVENT_PAYLOAD_MAX_BYTES + 1,
    }).pipe(Effect.orElseSucceed(() => null));
    if (collected === null) return hookResponse(400, "Bad Request");
    if (collected.bytes > PERSONAL_ROUTINE_EVENT_PAYLOAD_MAX_BYTES) {
      return hookResponse(413, "Payload Too Large");
    }

    const routines = yield* PersonalRoutineService;
    const outcome = yield* routines.fireEvent({
      hookToken,
      contentType: request.headers["content-type"] ?? null,
      body: collected.text,
    });
    switch (outcome._tag) {
      case "NotFound":
        return hookResponse(404, "Not Found");
      case "RateLimited":
        return hookResponse(429, "Too Many Requests", {
          "Retry-After": String(outcome.retryAfterSeconds),
        });
      case "Failed":
        return hookResponse(500, "Internal Server Error");
      case "Fired":
        return hookResponse(202, "Accepted");
    }
  }),
);

/** Browsers and link previewers will GET the URL; say so without leaking anything. */
export const personalRoutineHookMethodRouteLayer = HttpRouter.add(
  "GET",
  `${PERSONAL_ROUTINE_HOOK_ROUTE_PREFIX}/*`,
  Effect.succeed(hookResponse(405, "Method Not Allowed", { Allow: "POST" })),
);
