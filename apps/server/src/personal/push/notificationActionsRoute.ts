/**
 * The phone's notification actions, over bearer or DPoP auth only:
 *
 * - `GET  /api/personal/notifications/:id/content`
 * - `POST /api/personal/notifications/:id/reply   {commandId, text}`
 * - `POST /api/personal/notifications/:id/answer  {commandId, choice}`
 *
 * A push carries no text, so the app fetches it here when the push arrives.
 * Each route serves only the calling session's own user: another user's
 * notification id answers 404, the same as an id that never existed.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  PersonalNotificationAnswerInput,
  PersonalNotificationReplyInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { authenticateTokenPersonalRoute, personalRouteAuthResponses } from "../browser/routes.ts";
import { NotificationActions, outcomeStatus, type ActionOutcome } from "./notificationActions.ts";

export const PERSONAL_NOTIFICATIONS_PATH = "/api/personal/notifications";
const MAX_BODY_BYTES = 8192;

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

const text = (status: number, body: string) =>
  HttpServerResponse.text(body, { status, headers: HEADERS });

const json = (status: number, body: unknown) =>
  HttpServerResponse.json(body, { status, headers: HEADERS }).pipe(
    Effect.orElseSucceed(() => text(500, "Internal Server Error")),
  );

export type NotificationRoute =
  | { readonly id: string; readonly action: "content" }
  | { readonly id: string; readonly action: "reply" }
  | { readonly id: string; readonly action: "answer" };

/** The notification id and action named by a request path, or null when it is not one. */
export function parseNotificationPath(pathname: string): NotificationRoute | null {
  const prefix = `${PERSONAL_NOTIFICATIONS_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const parts = pathname.slice(prefix.length).split("/");
  if (parts.length !== 2) return null;
  const [encodedId, action] = parts;
  if (encodedId === undefined || encodedId.length === 0 || encodedId.length > 768) return null;
  if (action !== "content" && action !== "reply" && action !== "answer") return null;
  let id: string;
  try {
    id = decodeURIComponent(encodedId);
  } catch {
    return null;
  }
  if (id.length === 0 || id.length > 256) return null;
  return { id, action };
}

const decodeReply = Schema.decodeUnknownOption(PersonalNotificationReplyInput);
const decodeAnswer = Schema.decodeUnknownOption(PersonalNotificationAnswerInput);

const readBody = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
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
    if (collected === null || collected.bytes > MAX_BODY_BYTES) return null;
    try {
      return JSON.parse(collected.text) as unknown;
    } catch {
      return null;
    }
  });

const outcomeResponse = (outcome: ActionOutcome) =>
  json(
    outcomeStatus(outcome),
    outcome._tag === "Done"
      ? { ok: true }
      : outcome._tag === "Refused"
        ? { ok: false, error: outcome._tag, reason: outcome.reason }
        : { ok: false, error: outcome._tag },
  );

const internalError = () => text(500, "Internal Server Error");

export const personalNotificationContentRouteLayer = HttpRouter.add(
  "GET",
  `${PERSONAL_NOTIFICATIONS_PATH}/*`,
  Effect.gen(function* () {
    const session = yield* authenticateTokenPersonalRoute(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const route = parseNotificationPath((request.url ?? "").split("?", 1)[0] ?? "");
    if (route === null || route.action !== "content") return text(404, "Not Found");
    const actions = yield* NotificationActions;
    const found = yield* actions
      .content({ sessionId: session.sessionId, notificationId: route.id })
      .pipe(Effect.result);
    if (found._tag === "Failure") return internalError();
    if (Option.isNone(found.success)) return yield* outcomeResponse({ _tag: "NotFound" });
    return yield* json(200, found.success.value);
  }).pipe(Effect.catchTags(personalRouteAuthResponses)),
);

export const personalNotificationActionRouteLayer = HttpRouter.add(
  "POST",
  `${PERSONAL_NOTIFICATIONS_PATH}/*`,
  Effect.gen(function* () {
    const session = yield* authenticateTokenPersonalRoute(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const route = parseNotificationPath((request.url ?? "").split("?", 1)[0] ?? "");
    if (route === null || route.action === "content") return text(404, "Not Found");
    if (!/^application\/json\b/i.test(request.headers["content-type"] ?? "")) {
      return text(415, "Unsupported Media Type");
    }
    const body = yield* readBody(request);
    if (body === null) return text(400, "Bad Request");
    const actions = yield* NotificationActions;
    const target = { sessionId: session.sessionId, notificationId: route.id };
    if (route.action === "reply") {
      const input = decodeReply(body);
      if (Option.isNone(input)) return text(400, "Bad Request");
      const done = yield* actions.reply({ ...target, ...input.value }).pipe(Effect.result);
      return done._tag === "Failure" ? internalError() : yield* outcomeResponse(done.success);
    }
    const input = decodeAnswer(body);
    if (Option.isNone(input)) return text(400, "Bad Request");
    const done = yield* actions.answer({ ...target, ...input.value }).pipe(Effect.result);
    return done._tag === "Failure" ? internalError() : yield* outcomeResponse(done.success);
  }).pipe(Effect.catchTags(personalRouteAuthResponses)),
);
