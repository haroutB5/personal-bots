import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { EnvironmentAuth, ServerAuthMissingCredentialError } from "../../auth/EnvironmentAuth.ts";
import { PersonalBrowser } from "./PersonalBrowser.ts";
import { personalBrowserFilesRouteLayer, personalBrowserStreamRouteLayer } from "./routes.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (auth: "missing" | ReadonlyArray<AuthEnvironmentScope>) => {
  const calls = { attach: 0, resolve: 0 };
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(personalBrowserStreamRouteLayer, personalBrowserFilesRouteLayer).pipe(
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
        Layer.succeed(PersonalBrowser, {
          attachViewer: () =>
            Effect.sync(() => {
              calls.attach++;
            }).pipe(Effect.andThen(Effect.never)),
          resolveFile: () =>
            Effect.sync(() => {
              calls.resolve++;
              return Option.none();
            }),
        } as unknown as PersonalBrowser["Service"]),
      ),
      Layer.provideMerge(Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, calls };
};

const STREAM_URL = "http://t3.test/api/personal/browser/stream";
const FILE_URL = "http://t3.test/api/personal/browser/files";

describe("personal browser routes", () => {
  it("rejects an unauthenticated viewport upgrade before attaching a viewer", async () => {
    const { handler, calls } = fixture("missing");
    const response = await handler(new Request(STREAM_URL, { headers: { upgrade: "websocket" } }));
    expect(response.status).toBe(401);
    expect(calls.attach).toBe(0);
  });

  it("requires a websocket upgrade from an authenticated session", async () => {
    const { handler, calls } = fixture([AuthOrchestrationReadScope]);
    const response = await handler(new Request(STREAM_URL));
    expect(response.status).toBe(426);
    expect(calls.attach).toBe(0);
  });

  it("rejects an unauthenticated file download without resolving it", async () => {
    const { handler, calls } = fixture("missing");
    const response = await handler(new Request(`${FILE_URL}/${"a".repeat(32)}`));
    expect(response.status).toBe(401);
    expect(calls.resolve).toBe(0);
  });

  it("only resolves opaque file ids, never paths", async () => {
    const { handler, calls } = fixture([AuthOrchestrationReadScope]);
    const traversal = await handler(new Request(`${FILE_URL}/..%2F..%2Fstate.sqlite`));
    expect(traversal.status).toBe(404);
    expect(calls.resolve).toBe(0);
    const unknown = await handler(new Request(`${FILE_URL}/${"b".repeat(32)}`));
    expect(unknown.status).toBe(404);
    expect(calls.resolve).toBe(1);
  });
});
