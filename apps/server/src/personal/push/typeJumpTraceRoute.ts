import {
  AuthOrchestrationReadScope,
  PERSONAL_TYPE_JUMP_TRACE_PATH,
  PersonalTypeJumpTrace,
  TYPE_JUMP_TRACE_MAX_BYTES,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";

const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const reply = (status: number) => HttpServerResponse.empty({ status, headers });
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(PersonalTypeJumpTrace), {
  onExcessProperty: "error",
});

export const TYPE_JUMP_TRACE_WINDOW_MS = 5 * 60_000;
export const TYPE_JUMP_TRACE_PER_SESSION = 2;
export const TYPE_JUMP_TRACE_GLOBAL = 6;

export const makePersonalTypeJumpTraceRouteLayer = (
  options: { readonly record?: (line: string) => Effect.Effect<void> } = {},
) => {
  const record = options.record ?? ((line: string) => Effect.logInfo(`typejump-trace ${line}`));
  let windowStart = 0;
  let count = 0;
  const sessions = new Map<string, number>();

  return HttpRouter.add(
    "POST",
    PERSONAL_TYPE_JUMP_TRACE_PATH,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const auth = yield* EnvironmentAuth;
      const session = yield* auth.authenticateHttpRequest(request).pipe(
        Effect.map((value) => (value.scopes.includes(AuthOrchestrationReadScope) ? value : null)),
        Effect.orElseSucceed(() => null),
      );
      if (session === null) return reply(401);
      if (!/^application\/json\b/i.test(request.headers["content-type"] ?? "")) return reply(415);
      const declared = Number(request.headers["content-length"]);
      if (Number.isFinite(declared) && declared > TYPE_JUMP_TRACE_MAX_BYTES) return reply(413);

      const now = yield* Clock.currentTimeMillis;
      if (now - windowStart >= TYPE_JUMP_TRACE_WINDOW_MS) {
        windowStart = now;
        count = 0;
        sessions.clear();
      }
      const used = sessions.get(session.sessionId) ?? 0;
      if (count >= TYPE_JUMP_TRACE_GLOBAL || used >= TYPE_JUMP_TRACE_PER_SESSION) return reply(429);
      count += 1;
      sessions.set(session.sessionId, used + 1);

      let received = 0;
      const body = yield* collectUint8StreamText({
        stream: request.stream.pipe(
          Stream.takeUntil((chunk) => {
            received += chunk.byteLength;
            return received > TYPE_JUMP_TRACE_MAX_BYTES;
          }),
        ),
        maxBytes: TYPE_JUMP_TRACE_MAX_BYTES + 1,
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => null),
      );
      if (body === null) return reply(400);
      if (body.bytes > TYPE_JUMP_TRACE_MAX_BYTES) return reply(413);
      const parsed = yield* decode(body.text).pipe(Effect.option);
      if (parsed._tag === "None") return reply(400);
      // Re-encode the validated value, never the caller's raw text or auth data.
      const line = yield* Schema.encodeEffect(Schema.fromJsonString(PersonalTypeJumpTrace))(
        parsed.value,
      );
      yield* record(line);
      return reply(204);
    }),
  );
};

export const personalTypeJumpTraceRouteLayer = makePersonalTypeJumpTraceRouteLayer();
