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
import { makePersonalTypeJumpTraceRouteLayer } from "./typeJumpTraceRoute.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const trace = () => ({
  protocol: "typejump-v1",
  captureId: "0123456789abcdef0123456789abcdef",
  mode: "passive",
  stop: "timeout",
  entryAsset: "index-example.js",
  composerAsset: "pendingOutgoing-example.js",
  workerAsset: "sw.js",
  standalone: true,
  tween: true,
  reducedMotion: false,
  frozen: false,
  viewport: [390, 300, 100],
  samples: [[0, 0, 88, 487, 0, 12000, 274, 12274, 0, -12, 40, 1, 0, 0, 487, 873, 27]],
  writes: [],
});
const post = (value: unknown, contentType = "application/json") =>
  new Request("http://t3.test/api/personal/type-jump-trace", {
    method: "POST",
    body: JSON.stringify(value),
    headers: { "content-type": contentType },
  });
const fixture = (
  scopes: ReadonlyArray<AuthEnvironmentScope> | "missing" = [AuthOrchestrationReadScope],
) => {
  const lines: string[] = [];
  let sessionId = "test-session";
  const { handler, dispose } = HttpRouter.toWebHandler(
    makePersonalTypeJumpTraceRouteLayer({
      record: (line) =>
        Effect.sync(() => {
          lines.push(line);
        }),
    }).pipe(
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth, {
          authenticateHttpRequest: () =>
            scopes === "missing"
              ? Effect.fail(new ServerAuthMissingCredentialError({}))
              : Effect.succeed({
                  sessionId: AuthSessionId.make(sessionId),
                  subject: "test",
                  method: "browser-session-cookie",
                  scopes,
                }),
        } as unknown as EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return {
    handler,
    lines,
    session: (id: string) => {
      sessionId = id;
    },
  };
};

describe("ordered typing trace route", () => {
  it("requires an authenticated orchestration reader and logs no failed request data", async () => {
    for (const scopes of ["missing", []] as const) {
      const { handler, lines } = fixture(scopes);
      expect((await handler(post({ message: "private text" }))).status).toBe(401);
      expect(lines).toEqual([]);
    }
  });
  it("preserves signed ordered geometry with a bounded validated record", async () => {
    const { handler, lines } = fixture();
    const value = trace();
    const response = await handler(post(value));
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(lines).toEqual([JSON.stringify(value)]);
  });
  it("rejects unknown fields and string geometry without reflecting private content", async () => {
    for (const value of [
      { ...trace(), text: "private text" },
      { ...trace(), entryAsset: "https://example.test/private?token=secret" },
      { ...trace(), captureId: "real-message-id" },
      { ...trace(), samples: [["private text"]] },
      { ...trace(), samples: [...trace().samples, [0, -1, ...trace().samples[0]!.slice(2)]] },
      { ...trace(), samples: [[0, 20, ...trace().samples[0]!.slice(2)], trace().samples[0]] },
      { ...trace(), writes: [[0, 0, 0, 1, 1]] },
      {
        ...trace(),
        mode: "writers",
        writes: [
          [20, 0, 0, 1, 1],
          [10, 0, 1, 2, 2],
        ],
      },
    ]) {
      const { handler, lines } = fixture();
      expect((await handler(post(value))).status).toBe(400);
      expect(lines).toEqual([]);
    }
  });
  it("bounds body, samples, writer count and content type", async () => {
    for (const [value, type, status] of [
      ["x".repeat(32769), "application/json", 413],
      [{ ...trace(), samples: Array(321).fill(trace().samples[0]) }, "application/json", 400],
      [
        { ...trace(), mode: "writers", writes: Array(81).fill([0, 0, 0, 1, 1]) },
        "application/json",
        400,
      ],
      [trace(), "text/plain", 415],
    ] as const) {
      const { handler, lines } = fixture();
      expect((await handler(post(value, type))).status).toBe(status);
      expect(lines).toEqual([]);
    }
  });
  it("limits authenticated sessions separately while retaining a global ceiling", async () => {
    const { handler, session, lines } = fixture();
    expect((await handler(post(trace()))).status).toBe(204);
    expect((await handler(post(trace()))).status).toBe(204);
    expect((await handler(post(trace()))).status).toBe(429);
    for (const id of ["two", "three", "four", "five"]) {
      session(id);
      expect((await handler(post(trace()))).status).toBe(204);
    }
    session("six");
    expect((await handler(post(trace()))).status).toBe(429);
    expect(lines).toHaveLength(6);
  });
});
