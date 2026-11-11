// @effect-diagnostics nodeBuiltinImport:off - the fixture needs a real directory for the config.
import * as NodeOS from "node:os";

import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  type PerformanceStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import { PersonalBotRepository } from "../PersonalBotRepository.ts";
import type { PerformanceSampler } from "./performanceSampler.ts";
import {
  PERSONAL_PERFORMANCE_STREAM_PATH,
  makePersonalPerformanceStreamRouteLayer,
} from "./routes.ts";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = () => {
  let revoke: () => void = () => undefined;
  const revoked = new Promise<void>((resolve) => {
    revoke = resolve;
  });
  const counts = { subscribed: 0, unsubscribed: 0 };
  const sampler = {
    subscribe: () => {
      counts.subscribed += 1;
      return {
        hello: { kind: "hello" } as unknown as PerformanceStreamEvent,
        onEvent: () => undefined,
        unsubscribe: () => {
          counts.unsubscribed += 1;
        },
      };
    },
  } as unknown as PerformanceSampler;
  const { handler, dispose } = HttpRouter.toWebHandler(
    makePersonalPerformanceStreamRouteLayer({ buildSampler: () => sampler }).pipe(
      Layer.provideMerge(
        Layer.succeed(ServerConfig.ServerConfig, {
          baseDir: NodeOS.tmpdir(),
        } as unknown as ServerConfig.ServerConfig["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(PersonalBotRepository, {} as PersonalBotRepository["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(SessionStore, {
          awaitInvalidation: () => Effect.promise(() => revoked),
        } as unknown as SessionStore["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth, {
          authenticateWebSocketUpgrade: () =>
            Effect.succeed({
              sessionId: AuthSessionId.make("session-1"),
              subject: "test",
              method: "browser-session-cookie",
              scopes: [AuthOrchestrationReadScope],
            }),
        } as unknown as EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, revoke, counts };
};

const pending = Symbol("pending");

describe("the performance stream", () => {
  it("ends the stream and releases the viewer slot when its session is revoked", async () => {
    const { handler, revoke, counts } = fixture();
    const response = await handler(
      new Request(`http://t3.test${PERSONAL_PERFORMANCE_STREAM_PATH}`, { method: "GET" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const hello = await reader.read();
    expect(decoder.decode(hello.value)).toBe('data: {"kind":"hello"}\n\n');

    const whileLive = await Promise.race([
      reader.read(),
      new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 100)),
    ]);
    expect(whileLive).toBe(pending);
    expect(counts).toEqual({ subscribed: 1, unsubscribed: 0 });

    revoke();
    const ended = await Promise.race([
      reader.read(),
      new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 2000)),
    ]);
    expect(ended).toEqual({ done: true, value: undefined });
    expect(counts).toEqual({ subscribed: 1, unsubscribed: 1 });
  });
});
