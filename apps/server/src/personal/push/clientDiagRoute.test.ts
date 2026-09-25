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
  CLIENT_DIAG_MAX_PER_CLIENT_PER_MINUTE,
  CLIENT_DIAG_MAX_PER_MINUTE,
  CLIENT_DIAG_MAX_REFUSALS_LOGGED_PER_MINUTE,
  clientDiagLine,
  sanitizeClientDiag,
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
const post = (body: string, contentType = "application/json", ip?: string) =>
  new Request(URL_, {
    method: "POST",
    body,
    headers: { "content-type": contentType, ...(ip ? { "cf-connecting-ip": ip } : {}) },
  });
const tap = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ event: "notificationclick", route: "page", clients: [], ...extra });

describe("client diagnostics route", () => {
  it("logs one line for a signed-in tap record, marked signed-in", async () => {
    const { handler, lines } = fixture([AuthOrchestrationReadScope]);
    const response = await handler(post(tap()));
    expect(response.status).toBe(204);
    expect(lines).toEqual([
      '{"event":"notificationclick","route":"page","clients":[],"auth":"signed-in"}',
    ]);
  });

  it("accepts anonymous callers (the phone's worker may hold no cookie), marked anonymous", async () => {
    const { handler, lines } = fixture("missing");
    const response = await handler(post(tap({ id: "tap-1" })));
    expect(response.status).toBe(204);
    expect(lines).toEqual([
      '{"event":"notificationclick","id":"tap-1","route":"page","clients":[],"auth":"anonymous"}',
    ]);
  });

  it("refuses non-JSON, non-objects, unknown events and oversize bodies, and logs each refusal", async () => {
    const { handler, lines } = fixture("missing");
    expect((await handler(post("a=1", "application/x-www-form-urlencoded"))).status).toBe(415);
    expect((await handler(post("[1,2]"))).status).toBe(400);
    expect((await handler(post("not json"))).status).toBe(400);
    expect((await handler(post('{"event":"anything-else"}'))).status).toBe(400);
    expect((await handler(post("x".repeat(CLIENT_DIAG_MAX_BYTES + 10)))).status).toBe(413);
    expect(lines).toEqual([
      '{"event":"refused","reason":"content-type","status":415,"auth":"anonymous"}',
      '{"event":"refused","reason":"not-allowlisted","status":400,"auth":"anonymous"}',
      '{"event":"refused","reason":"not-allowlisted","status":400,"auth":"anonymous"}',
      '{"event":"refused","reason":"not-allowlisted","status":400,"auth":"anonymous"}',
      '{"event":"refused","reason":"too-large","status":413,"auth":"anonymous"}',
    ]);
  });

  it("caps each client, and all clients together", async () => {
    const { handler, lines } = fixture("missing");
    const statuses: number[] = [];
    for (let index = 0; index < CLIENT_DIAG_MAX_PER_CLIENT_PER_MINUTE + 2; index++) {
      statuses.push((await handler(post(tap({ ms: index }), undefined, "203.0.113.7"))).status);
    }
    expect(statuses.filter((status) => status === 204)).toHaveLength(
      CLIENT_DIAG_MAX_PER_CLIENT_PER_MINUTE,
    );
    expect(statuses.slice(-2)).toEqual([429, 429]);

    let accepted = CLIENT_DIAG_MAX_PER_CLIENT_PER_MINUTE;
    for (let index = 0; accepted < CLIENT_DIAG_MAX_PER_MINUTE + 5; index++) {
      const status = (await handler(post(tap(), undefined, `198.51.100.${index}`))).status;
      if (status === 204) accepted += 1;
      else {
        expect(status).toBe(429);
        break;
      }
    }
    expect(accepted).toBe(CLIENT_DIAG_MAX_PER_MINUTE);
    const refusals = lines.filter((line) => line.includes('"refused"'));
    expect(refusals.length).toBeLessThanOrEqual(CLIENT_DIAG_MAX_REFUSALS_LOGGED_PER_MINUTE);
  });

  it("rebuilds the record from the allowlist and drops everything else", () => {
    expect(
      sanitizeClientDiag(
        JSON.stringify({
          event: "tap-received",
          id: "abc-123",
          url: "/bots/x/y?z=1",
          via: "cache-poll",
          visibility: "visible",
          navigated: true,
          controlled: false,
          secret: "sk-live-nope",
          page: "<script>",
          ms: 12,
          clients: [{ path: "/bots", visibility: "visible", focused: true, extra: 1 }],
          ack: { via: "broadcast", visibility: "visible", nested: { a: 1 } },
        }),
      ),
    ).toEqual({
      event: "tap-received",
      id: "abc-123",
      url: "/bots/x/y?z=1",
      via: "cache-poll",
      visibility: "visible",
      navigated: true,
      controlled: false,
      ms: 12,
      clients: [{ path: "/bots", visibility: "visible", focused: true }],
      ack: { via: "broadcast", visibility: "visible" },
    });
  });

  it("drops paths and tokens that could forge or bloat a log line", () => {
    const record = sanitizeClientDiag(
      JSON.stringify({
        event: "notificationclick",
        url: "/bots\nforged line",
        id: "x".repeat(65),
        route: "page page",
        error: `TypeError: ${String.fromCharCode(7)}bell`,
        ms: -1,
      }),
    );
    expect(record).toEqual({ event: "notificationclick" });
    expect(
      sanitizeClientDiag(JSON.stringify({ event: "page-boot", url: "//evil.test/x" })),
    ).toEqual({ event: "page-boot" });
  });

  it("accepts real-user timing beacons with their few fields", () => {
    expect(
      sanitizeClientDiag(
        JSON.stringify({
          event: "perf",
          journey: "j2",
          ms: 842,
          warm: true,
          via: "relay",
          snapshot: false,
          stack: "not kept",
        }),
      ),
    ).toEqual({ event: "perf", journey: "j2", ms: 842, warm: true, via: "relay", snapshot: false });
  });

  it("accepts the stale-notification cleanup line: how many, and why", () => {
    expect(
      sanitizeClientDiag(
        JSON.stringify({
          event: "notifications-cleared",
          closed: 3,
          reason: "visible",
          visibility: "visible",
          waitedMs: 8000,
          afterTap: false,
          titles: ["not kept"],
        }),
      ),
    ).toEqual({
      event: "notifications-cleared",
      closed: 3,
      reason: "visible",
      visibility: "visible",
      waitedMs: 8000,
      afterTap: false,
    });
  });

  it("accepts the skipped cleanup line, which shows a cleanup racing a tap", () => {
    expect(
      sanitizeClientDiag(
        JSON.stringify({
          event: "notifications-clear-skipped",
          reason: "focus",
          waitedMs: 321,
          afterTap: true,
        }),
      ),
    ).toEqual({
      event: "notifications-clear-skipped",
      reason: "focus",
      waitedMs: 321,
      afterTap: true,
    });
  });

  it("keeps one record on one bounded line", () => {
    const line = clientDiagLine(tap(), "anonymous");
    expect(line).not.toContain(String.fromCharCode(10));
    expect(line!.length).toBeLessThanOrEqual(CLIENT_DIAG_LOGGED_CHARS + 3);
  });
});
