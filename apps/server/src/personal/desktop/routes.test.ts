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
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { EnvironmentAuth, ServerAuthMissingCredentialError } from "../../auth/EnvironmentAuth.ts";
import type { LiveViewer } from "./DesktopLiveView.ts";
import { PersonalDesktop } from "./PersonalDesktop.ts";
import { handleDesktopViewMessage, personalDesktopStreamRouteLayer } from "./routes.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (auth: "missing" | ReadonlyArray<AuthEnvironmentScope>) => {
  const calls = { watch: 0 };
  const { handler, dispose } = HttpRouter.toWebHandler(
    personalDesktopStreamRouteLayer.pipe(
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth, {
          authenticateWebSocketUpgrade: () =>
            auth === "missing"
              ? Effect.fail(new ServerAuthMissingCredentialError({}))
              : Effect.succeed({
                  sessionId: AuthSessionId.make("session-1"),
                  subject: "test",
                  method: "bearer-access-token",
                  scopes: auth,
                }),
        } as unknown as EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(PersonalDesktop, {
          watch: () =>
            Effect.sync(() => {
              calls.watch++;
              return null;
            }),
        } as unknown as PersonalDesktop["Service"]),
      ),
      Layer.provideMerge(Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, calls };
};

const STREAM_URL = "http://t3.test/api/personal/desktop/stream";

describe("personal desktop live view route", () => {
  it("rejects an unauthenticated upgrade before any capture starts", async () => {
    const { handler, calls } = fixture("missing");
    const response = await handler(new Request(STREAM_URL, { headers: { upgrade: "websocket" } }));
    expect(response.status).toBe(401);
    expect(calls.watch).toBe(0);
  });

  it("needs operate scope: a read-only session cannot watch the PC", async () => {
    const { handler, calls } = fixture([AuthOrchestrationReadScope]);
    const response = await handler(new Request(STREAM_URL, { headers: { upgrade: "websocket" } }));
    expect(response.status).toBe(403);
    expect(calls.watch).toBe(0);
  });

  it("requires a websocket upgrade from an authorised session", async () => {
    const { handler, calls } = fixture([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
    const response = await handler(new Request(STREAM_URL));
    expect(response.status).toBe(426);
    expect(calls.watch).toBe(0);
  });

  it("is view only: acks and the viewport box are the only messages it acts on", () => {
    const seen: string[] = [];
    const viewer: LiveViewer = {
      ack: () => seen.push("ack"),
      setViewport: (width, height) => seen.push(`viewport ${width}x${height}`),
      detach: () => seen.push("detach"),
      stats: () => ({
        frames: 0,
        bytes: 0,
        captures: 0,
        unchanged: 0,
        captureMsTotal: 0,
        startedAt: 0,
      }),
    };
    handleDesktopViewMessage(viewer, JSON.stringify({ _tag: "Ack" }));
    handleDesktopViewMessage(
      viewer,
      JSON.stringify({ _tag: "Viewport", width: 1170, height: 731 }),
    );
    handleDesktopViewMessage(
      viewer,
      JSON.stringify({ _tag: "Pointer", action: "tap", x: 5, y: 5 }),
    );
    handleDesktopViewMessage(viewer, JSON.stringify({ _tag: "Key", key: "Enter" }));
    handleDesktopViewMessage(viewer, "not json");
    expect(seen).toEqual(["ack", "viewport 1170x731"]);
  });
});
