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
import {
  CLIENT_DIAG_LOGGED_CHARS,
  CLIENT_DIAG_MAX_BYTES,
  CLIENT_DIAG_MAX_PER_MINUTE,
  clientDiagLine,
  makePersonalClientDiagRouteLayer,
} from "./clientDiagRoute.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (auth: "missing" | ReadonlyArray<AuthEnvironmentScope>) => {
  const lines: string[] = [];
  const { handler, dispose } = HttpRouter.toWebHandler(
    makePersonalClientDiagRouteLayer({
      record: (line) => Effect.sync(() => void lines.push(line)),
    }).pipe(
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
  return { handler, lines };
};

const URL_ = "http://t3.test/api/personal/client-diag";
const post = (body: string, contentType = "application/json") =>
  new Request(URL_, { method: "POST", body, headers: { "content-type": contentType } });

describe("client diagnostics route", () => {
  it("logs one line for a signed-in tap record", async () => {
    const { handler, lines } = fixture([AuthOrchestrationReadScope]);
    const response = await handler(
      post(JSON.stringify({ event: "notificationclick", route: "page", clients: [] })),
    );
    expect(response.status).toBe(204);
    expect(lines).toEqual(['{"event":"notificationclick","route":"page","clients":[]}']);
  });

  it("refuses anonymous callers before reading anything", async () => {
    const { handler, lines } = fixture("missing");
    const response = await handler(post("{}"));
    expect(response.status).toBe(401);
    expect(lines).toEqual([]);
  });

  it("accepts JSON objects only", async () => {
    const { handler, lines } = fixture([AuthOrchestrationReadScope]);
    expect((await handler(post("a=1", "application/x-www-form-urlencoded"))).status).toBe(415);
    expect((await handler(post("[1,2]"))).status).toBe(400);
    expect((await handler(post("not json"))).status).toBe(400);
    expect((await handler(post("x".repeat(CLIENT_DIAG_MAX_BYTES + 10)))).status).toBe(413);
    expect(lines).toEqual([]);
  });

  it("caps the rate so a looping client cannot flood the log", async () => {
    const { handler, lines } = fixture([AuthOrchestrationReadScope]);
    const statuses: number[] = [];
    for (let index = 0; index < CLIENT_DIAG_MAX_PER_MINUTE + 3; index++) {
      statuses.push((await handler(post(`{"n":${index}}`))).status);
    }
    expect(statuses.filter((status) => status === 204)).toHaveLength(CLIENT_DIAG_MAX_PER_MINUTE);
    expect(statuses.slice(-3)).toEqual([429, 429, 429]);
    expect(lines).toHaveLength(CLIENT_DIAG_MAX_PER_MINUTE);
  });

  it("keeps one record on one bounded line", () => {
    expect(clientDiagLine('{"url":"/bots\\nforged line"}')).toBe('{"url":"/bots\\nforged line"}');
    const long = clientDiagLine(JSON.stringify({ text: "y".repeat(3000) }));
    expect(long?.length).toBe(CLIENT_DIAG_LOGGED_CHARS + 3);
  });
});
