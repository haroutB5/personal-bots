// @effect-diagnostics nodeBuiltinImport:off - Drives the real /ws upgrade on loopback.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { AuthStandardClientScopes, ORCHESTRATION_PROTOCOL_QUERY_PARAM } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/http";
import { vi } from "vite-plus/test";

import { openSocketUrl } from "./mobilePairing.mjs";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import { layerMakeServer } from "../../server.ts";

vi.mock("../../../../../apps/hbots-mobile/src/dpop.ts", () => ({
  createDpopProof: async () => ({ proof: "test-proof", thumbprint: "test-thumbprint" }),
  loadOrCreateDpopKey: async () => ({
    privateJwk: {},
    publicJwk: {},
    thumbprint: "test-thumbprint",
  }),
}));

const testConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web" as const,
      startupPresentation: "headless" as const,
      noBrowser: true,
      host: "127.0.0.1",
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-orchestration-protocol-" })),
);

const layerTestServer = layerMakeServer.pipe(
  Layer.provide(testConfig),
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

interface UpgradeResult {
  readonly status: number;
  readonly body: string;
}

function upgrade(socketUrl: string): Promise<UpgradeResult> {
  return new Promise((resolve) => {
    const url = new URL(socketUrl.replace(/^ws/, "http"));
    const request = NodeHttp.request(url, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode ?? 0, body: "(upgraded)" });
    });
    request.on("response", (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", (error) => resolve({ status: 0, body: String(error) }));
    request.end();
  });
}

it.live(
  "the phone's own socket URL upgrades on /ws and the same URL without the protocol gets 426",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(layerTestServer);
      const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
      const sessions = Context.get(services, SessionStore.SessionStore);
      const descriptor = yield* Context.get(services, ServerEnvironment.ServerEnvironment)
        .getDescriptor;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "orchestration-protocol-test",
        scopes: AuthStandardClientScopes,
        client: { label: "protocol test", deviceType: "mobile", os: "android" },
      });

      const socketUrl = yield* Effect.promise(() =>
        openSocketUrl(
          {
            environmentId: descriptor.environmentId,
            label: descriptor.label,
            httpBaseUrl: origin,
            wsBaseUrl: origin.replace(/^http/, "ws"),
            accessToken: issued.token,
            scope: issued.scopes.join(" "),
            expiresAt: 1,
            pairedAt: 1,
          },
          "1.67.0",
        ),
      );

      const url = new URL(socketUrl);
      expect(url.pathname).toBe("/ws");
      expect(yield* Effect.promise(() => upgrade(socketUrl))).toEqual({
        status: 101,
        body: "(upgraded)",
      });
      expect(url.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM)).toBe("2");

      url.searchParams.delete(ORCHESTRATION_PROTOCOL_QUERY_PARAM);
      const withoutProtocol = yield* Effect.promise(() => upgrade(url.toString()));
      expect(withoutProtocol.status).toBe(426);
      expect(JSON.parse(withoutProtocol.body)).toMatchObject({
        code: "orchestration_protocol_incompatible",
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer)),
    ),
);
