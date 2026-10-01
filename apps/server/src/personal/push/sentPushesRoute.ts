/**
 * `POST /api/personal/push/sent`: which pushes this server sent to the
 * calling device since the app went away, for a notification tap iOS never
 * dispatched (web features/personal/serverLostTap.ts).
 *
 * The phone could not answer this itself: on 1 Oct an Assistant reply was
 * pushed at 07:16:59 and tapped, and at the 07:18:46 resume both the worker's
 * list and getNotifications() came back empty, while fresh launches saw them.
 * The server's outbox records every push it delivered, per subscription, so
 * it is the one record iOS cannot lose.
 *
 * Signed-in callers with read scope only (as personalPush.getSettings), the
 * same session check as the other personal routes. The device names itself by
 * its push subscription endpoint, which only that browser and this server
 * know. The answer is the deep links and send times of at most
 * SENT_PUSHES_LOOKBACK_MS of pushes, never their text.
 */
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { authenticatePersonalRoute, personalRouteAuthResponses } from "../browser/routes.ts";
import { PersonalPushService } from "./PersonalPushService.ts";
import { isAllowedPushEndpoint } from "./webPushCrypto.ts";

export const PERSONAL_PUSH_SENT_PATH = "/api/personal/push/sent";
/** How far back an answer reaches, whatever the caller asks for. */
export const SENT_PUSHES_LOOKBACK_MS = 2 * 60_000;
const MAX_BODY_BYTES = 4096;

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

const text = (status: number, body: string) =>
  HttpServerResponse.text(body, { status, headers: HEADERS });

export interface SentPushesRequest {
  readonly endpoint: string;
  /**
   * How long the app has been away, by the phone's own clock; null when it
   * does not know (a launch with no record). A duration rather than a time,
   * so a phone clock that disagrees with this one cannot shift the window.
   */
  readonly awayMs: number | null;
}

/** The request body, or null when it is not one. */
export function parseSentPushesRequest(body: string): SentPushesRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { endpoint, awayMs } = value as { endpoint?: unknown; awayMs?: unknown };
  if (typeof endpoint !== "string" || endpoint.length > 2048) return null;
  if (!isAllowedPushEndpoint(endpoint)) return null;
  const away = typeof awayMs === "number" && Number.isFinite(awayMs) && awayMs >= 0 ? awayMs : null;
  return { endpoint, awayMs: away };
}

/** From when an answer covers (ISO): since the app went away, never more than the lookback. */
export function sentPushesFrom(awayMs: number | null, now: number): string {
  const back =
    awayMs === null ? SENT_PUSHES_LOOKBACK_MS : Math.min(awayMs, SENT_PUSHES_LOOKBACK_MS);
  return DateTime.formatIso(DateTime.makeUnsafe(now - back));
}

export const personalPushSentRouteLayer = HttpRouter.add(
  "POST",
  PERSONAL_PUSH_SENT_PATH,
  Effect.gen(function* () {
    // Authenticate before anything else so an anonymous probe learns nothing.
    yield* authenticatePersonalRoute(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!/^application\/json\b/i.test(request.headers["content-type"] ?? "")) {
      return text(415, "Unsupported Media Type");
    }
    let received = 0;
    const collected = yield* collectUint8StreamText({
      stream: request.stream.pipe(
        Stream.takeUntil((chunk) => {
          received += chunk.byteLength;
          return received > MAX_BODY_BYTES;
        }),
      ),
      maxBytes: MAX_BODY_BYTES + 1,
    }).pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => null),
    );
    if (collected === null || collected.bytes > MAX_BODY_BYTES) {
      return text(400, "Bad Request");
    }
    const input = parseSentPushesRequest(collected.text);
    if (input === null) return text(400, "Bad Request");
    const now = yield* Clock.currentTimeMillis;
    const push = yield* PersonalPushService;
    const answer = yield* push
      .sentSince({
        endpoint: input.endpoint,
        since: sentPushesFrom(input.awayMs, now),
      })
      .pipe(Effect.result);
    if (answer._tag === "Failure") return text(500, "Internal Server Error");
    return yield* HttpServerResponse.json(answer.success, { headers: HEADERS }).pipe(
      Effect.orElseSucceed(() => text(500, "Internal Server Error")),
    );
  }).pipe(Effect.catchTags(personalRouteAuthResponses)),
);
