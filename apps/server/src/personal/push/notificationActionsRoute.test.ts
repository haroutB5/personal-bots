import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter } from "effect/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { EnvironmentAuth, ServerAuthMissingCredentialError } from "../../auth/EnvironmentAuth.ts";
import { NotificationActions, type ActionOutcome } from "./notificationActions.ts";
import {
  PERSONAL_NOTIFICATIONS_PATH,
  parseNotificationPath,
  personalNotificationActionRouteLayer,
  personalNotificationContentRouteLayer,
} from "./notificationActionsRoute.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

type Auth = "anonymous" | "revoked" | ReadonlyArray<AuthEnvironmentScope>;

interface Calls {
  readonly content: Array<{ sessionId: string; notificationId: string }>;
  readonly reply: Array<Record<string, unknown>>;
  readonly answer: Array<Record<string, unknown>>;
}

const CONTENT = {
  notificationId: "chat-needs:req-1",
  kind: "question",
  botId: "bot-1",
  threadId: "thread-1",
  text: "Which table?",
  question: { requestId: "req-1", question: "Which table?", inlineOptions: ["Window", "Bar"] },
} as const;

const fixture = (
  auth: Auth,
  outcome: ActionOutcome = { _tag: "Done" },
  found: boolean = true,
  method: "bearer-access-token" | "browser-session-cookie" = "bearer-access-token",
) => {
  const calls: Calls = { content: [], reply: [], answer: [] };
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(
      personalNotificationContentRouteLayer,
      personalNotificationActionRouteLayer,
    ).pipe(
      Layer.provideMerge(
        Layer.succeed(NotificationActions, {
          content: (input: { sessionId: string; notificationId: string }) =>
            Effect.sync(() => {
              calls.content.push(input);
              return found ? Option.some(CONTENT) : Option.none();
            }),
          reply: (input: Record<string, unknown>) =>
            Effect.sync(() => {
              calls.reply.push(input);
              return outcome;
            }),
          answer: (input: Record<string, unknown>) =>
            Effect.sync(() => {
              calls.answer.push(input);
              return outcome;
            }),
        } as unknown as NotificationActions["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth, {
          authenticateHttpRequest: () =>
            auth === "anonymous" || auth === "revoked"
              ? Effect.fail(new ServerAuthMissingCredentialError({}))
              : Effect.succeed({
                  sessionId: AuthSessionId.make("session-1"),
                  subject: "test",
                  method,
                  scopes: auth,
                }),
        } as unknown as EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, calls };
};

const url = (id: string, action: string) =>
  `http://t3.test${PERSONAL_NOTIFICATIONS_PATH}/${encodeURIComponent(id)}/${action}`;

const BEARER = { authorization: "Bearer token" };

const get = (id: string, headers: Record<string, string> = BEARER) =>
  new Request(url(id, "content"), { headers });

const post = (
  id: string,
  action: "reply" | "answer",
  body: unknown,
  headers: Record<string, string> = { ...BEARER, "content-type": "application/json" },
) =>
  new Request(url(id, action), {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers,
  });

const READ = [AuthOrchestrationReadScope] as const;
const OPERATE = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] as const;

describe("GET content", () => {
  it("serves the signed-in session its notification, never cached", async () => {
    const { handler, calls } = fixture(READ);
    const response = await handler(get("chat-needs:req-1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(CONTENT);
    expect(calls.content).toEqual([{ sessionId: "session-1", notificationId: "chat-needs:req-1" }]);
  });

  it("answers 404 for an id that is not this user's", async () => {
    const { handler } = fixture(READ, { _tag: "Done" }, false);
    const response = await handler(get("chat-needs:req-1"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "NotFound" });
  });

  it("answers 401 to anonymous callers, revoked sessions and cookie sessions, before reading", async () => {
    for (const auth of ["anonymous", "revoked"] as const) {
      const { handler, calls } = fixture(auth);
      expect((await handler(get("chat-needs:req-1"))).status).toBe(401);
      expect(calls.content).toEqual([]);
    }
    const noCredential = fixture(READ);
    expect((await noCredential.handler(get("chat-needs:req-1", {}))).status).toBe(401);
    const cookie = fixture(READ, { _tag: "Done" }, true, "browser-session-cookie");
    expect((await cookie.handler(get("chat-needs:req-1"))).status).toBe(401);
    expect(cookie.calls.content).toEqual([]);
  });

  it("answers 403 without read scope", async () => {
    const { handler, calls } = fixture([]);
    expect((await handler(get("chat-needs:req-1"))).status).toBe(403);
    expect(calls.content).toEqual([]);
  });
});

describe("POST reply and answer", () => {
  it("replies once for the session, with the command id and text it sent", async () => {
    const { handler, calls } = fixture(OPERATE);
    const response = await handler(
      post("chat-needs:req-1", "reply", { commandId: "cmd-1", text: "Window, please" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls.reply).toEqual([
      {
        sessionId: "session-1",
        notificationId: "chat-needs:req-1",
        commandId: "cmd-1",
        text: "Window, please",
      },
    ]);
  });

  it("answers with the label the phone chose", async () => {
    const { handler, calls } = fixture(OPERATE);
    const response = await handler(
      post("chat-needs:req-1", "answer", { commandId: "cmd-2", choice: "Window" }),
    );
    expect(response.status).toBe(200);
    expect(calls.answer).toEqual([
      {
        sessionId: "session-1",
        notificationId: "chat-needs:req-1",
        commandId: "cmd-2",
        choice: "Window",
      },
    ]);
  });

  it("maps a stale request to 409, a refusal to 422 with its reason, and an unknown id to 404", async () => {
    const stale = fixture(OPERATE, { _tag: "Stale" });
    const staleResponse = await stale.handler(
      post("chat-needs:req-1", "answer", { commandId: "c", choice: "Window" }),
    );
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toEqual({ ok: false, error: "Stale" });

    const refused = fixture(OPERATE, { _tag: "Refused", reason: "secret-request" });
    const refusedResponse = await refused.handler(
      post("chat-needs:req-1", "answer", { commandId: "c", choice: "Window" }),
    );
    expect(refusedResponse.status).toBe(422);
    expect(await refusedResponse.json()).toEqual({
      ok: false,
      error: "Refused",
      reason: "secret-request",
    });

    const missing = fixture(OPERATE, { _tag: "NotFound" });
    expect(
      (await missing.handler(post("chat-needs:req-1", "reply", { commandId: "c", text: "hello" })))
        .status,
    ).toBe(404);
  });

  it("answers 401 to anonymous and revoked sessions and 403 without operate scope, with no effect", async () => {
    for (const auth of ["anonymous", "revoked"] as const) {
      const { handler, calls } = fixture(auth);
      const response = await handler(
        post("chat-needs:req-1", "answer", { commandId: "c", choice: "Window" }),
      );
      expect(response.status).toBe(401);
      expect(calls.answer).toEqual([]);
    }
    const readOnly = fixture(READ);
    expect(
      (await readOnly.handler(post("chat-needs:req-1", "reply", { commandId: "c", text: "hello" })))
        .status,
    ).toBe(403);
    expect(readOnly.calls.reply).toEqual([]);
  });

  it("refuses a body that is not what the route takes, before any effect", async () => {
    const { handler, calls } = fixture(OPERATE);
    const json = { ...BEARER, "content-type": "application/json" };
    expect(
      (
        await handler(
          post("chat-needs:req-1", "reply", "{}", { ...BEARER, "content-type": "text/plain" }),
        )
      ).status,
    ).toBe(415);
    expect((await handler(post("chat-needs:req-1", "reply", "not json", json))).status).toBe(400);
    expect((await handler(post("chat-needs:req-1", "reply", { text: "no id" }))).status).toBe(400);
    expect(
      (await handler(post("chat-needs:req-1", "reply", { commandId: "c", text: "   " }))).status,
    ).toBe(400);
    expect(
      (await handler(post("chat-needs:req-1", "reply", { commandId: "c", text: "x".repeat(4001) })))
        .status,
    ).toBe(400);
    expect(
      (await handler(post("chat-needs:req-1", "answer", { commandId: "c", choice: 3 }))).status,
    ).toBe(400);
    expect(
      (
        await handler(
          post("chat-needs:req-1", "answer", { commandId: "c".repeat(129), choice: "A" }),
        )
      ).status,
    ).toBe(400);
    expect((await handler(post("chat-needs:req-1", "answer", "x".repeat(9000), json))).status).toBe(
      400,
    );
    expect(calls.reply).toEqual([]);
    expect(calls.answer).toEqual([]);
  });

  it("does not accept content as a POST or reply as a GET", async () => {
    const { handler } = fixture(OPERATE);
    expect(
      (
        await handler(
          new Request(url("chat-needs:req-1", "content"), {
            method: "POST",
            headers: { ...BEARER, "content-type": "application/json" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await handler(new Request(url("chat-needs:req-1", "reply"), { headers: BEARER }))).status,
    ).toBe(404);
  });
});

describe("parseNotificationPath", () => {
  it("reads the id and action, decoding an id with a colon", () => {
    expect(
      parseNotificationPath(`${PERSONAL_NOTIFICATIONS_PATH}/chat-needs%3Areq-1/content`),
    ).toEqual({
      id: "chat-needs:req-1",
      action: "content",
    });
    expect(parseNotificationPath(`${PERSONAL_NOTIFICATIONS_PATH}/abc/answer`)).toEqual({
      id: "abc",
      action: "answer",
    });
  });

  it("rejects anything else", () => {
    for (const path of [
      PERSONAL_NOTIFICATIONS_PATH,
      `${PERSONAL_NOTIFICATIONS_PATH}/`,
      `${PERSONAL_NOTIFICATIONS_PATH}/abc`,
      `${PERSONAL_NOTIFICATIONS_PATH}/abc/other`,
      `${PERSONAL_NOTIFICATIONS_PATH}//content`,
      `${PERSONAL_NOTIFICATIONS_PATH}/abc/content/extra`,
      `${PERSONAL_NOTIFICATIONS_PATH}/%E0%A4%A/content`,
      `${PERSONAL_NOTIFICATIONS_PATH}/${"a".repeat(257)}/content`,
      "/api/personal/other/abc/content",
    ]) {
      expect(parseNotificationPath(path)).toBeNull();
    }
  });
});
