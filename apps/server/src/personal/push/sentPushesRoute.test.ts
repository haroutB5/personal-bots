import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { EnvironmentAuth, ServerAuthMissingCredentialError } from "../../auth/EnvironmentAuth.ts";
import { PersonalPushService } from "./PersonalPushService.ts";
import {
  PERSONAL_PUSH_SENT_PATH,
  SENT_PUSHES_LOOKBACK_MS,
  parseSentPushesRequest,
  personalPushSentRouteLayer,
  sentPushesFrom,
} from "./sentPushesRoute.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const IPHONE = "https://web.push.apple.com/QGuYx-device";
const ASSISTANT_CHAT = "/bots/personal-seed-assistant/0c4b1d06-0852-4d28-8904-6ca40ac017e8";

const fixture = (auth: "missing" | ReadonlyArray<AuthEnvironmentScope>) => {
  const asked: Array<{ endpoint: string; since: string }> = [];
  const { handler, dispose } = HttpRouter.toWebHandler(
    personalPushSentRouteLayer.pipe(
      Layer.provideMerge(
        Layer.succeed(PersonalPushService, {
          sentSince: (input: { endpoint: string; since: string }) =>
            Effect.sync(() => {
              asked.push(input);
              return input.endpoint === IPHONE
                ? {
                    known: true,
                    pushes: [{ url: ASSISTANT_CHAT, sentAt: "2026-10-01T06:16:59.100Z" }],
                  }
                : { known: false, pushes: [] };
            }),
        } as unknown as PersonalPushService["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth, {
          authenticateWebSocketUpgrade: () =>
            auth === "missing"
              ? Effect.fail(new ServerAuthMissingCredentialError({}))
              : Effect.succeed({
                  sessionId: AuthSessionId.make("session-1"),
                  subject: "test",
                  method: "browser-session-cookie",
                  scopes: auth,
                }),
        } as unknown as EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, asked };
};

const post = (body: unknown, contentType = "application/json") =>
  new Request(`http://t3.test${PERSONAL_PUSH_SENT_PATH}`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": contentType },
  });

describe("pushes sent to this device", () => {
  it("answers a signed-in device with the pushes it was sent", async () => {
    const { handler, asked } = fixture([AuthOrchestrationReadScope]);
    const response = await handler(post({ endpoint: IPHONE, awayMs: 10_000 }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      known: true,
      pushes: [{ url: ASSISTANT_CHAT, sentAt: "2026-10-01T06:16:59.100Z" }],
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.endpoint).toBe(IPHONE);
  });

  it("says when it does not know the device", async () => {
    const { handler } = fixture([AuthOrchestrationReadScope]);
    const response = await handler(
      post({ endpoint: "https://fcm.googleapis.com/fcm/send/other", awayMs: 0 }),
    );
    expect(await response.json()).toEqual({ known: false, pushes: [] });
  });

  it("refuses callers who are not signed in, or lack read scope, before reading anything", async () => {
    const anonymous = fixture("missing");
    expect((await anonymous.handler(post({ endpoint: IPHONE, awayMs: 0 }))).status).toBe(401);
    expect(anonymous.asked).toHaveLength(0);
    const noScope = fixture([]);
    expect((await noScope.handler(post({ endpoint: IPHONE, awayMs: 0 }))).status).toBe(403);
    expect(noScope.asked).toHaveLength(0);
  });

  it("refuses bodies that are not a push endpoint and a time", async () => {
    const { handler, asked } = fixture([AuthOrchestrationReadScope]);
    expect((await handler(post({ endpoint: IPHONE }, "text/plain"))).status).toBe(415);
    expect((await handler(post("not json"))).status).toBe(400);
    expect((await handler(post({ endpoint: "https://evil.example/push", awayMs: 0 }))).status).toBe(
      400,
    );
    expect((await handler(post({ endpoint: `${IPHONE}/${"x".repeat(5000)}` }))).status).toBe(400);
    expect(asked).toHaveLength(0);
  });
});

describe("how far back an answer reaches", () => {
  const now = Date.parse("2026-10-01T06:18:46.521Z");

  it("starts when the app went away (07:16:49.95 BST for the 07:18:46 resume)", () => {
    expect(sentPushesFrom(116_573, now)).toBe("2026-10-01T06:16:49.948Z");
  });

  it("never reaches back more than two minutes, however long the app was away", () => {
    expect(SENT_PUSHES_LOOKBACK_MS).toBe(120_000);
    expect(sentPushesFrom(60 * 60_000, now)).toBe("2026-10-01T06:16:46.521Z");
    expect(sentPushesFrom(null, now)).toBe("2026-10-01T06:16:46.521Z");
  });

  it("reads a missing or bad away time as unknown, never as the future", () => {
    expect(parseSentPushesRequest(JSON.stringify({ endpoint: IPHONE, awayMs: "x" }))).toEqual({
      endpoint: IPHONE,
      awayMs: null,
    });
    expect(parseSentPushesRequest(JSON.stringify({ endpoint: IPHONE, awayMs: -5 }))).toEqual({
      endpoint: IPHONE,
      awayMs: null,
    });
  });
});
