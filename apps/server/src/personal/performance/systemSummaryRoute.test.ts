// @effect-diagnostics nodeBuiltinImport:off - the fixture needs a real directory for statfs.
import * as NodeOS from "node:os";

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
import * as ServerConfig from "../../config.ts";
import { HostResources } from "../../resourceTelemetry/HostResources.ts";
import {
  PERSONAL_SYSTEM_SUMMARY_PATH,
  diskLabelOf,
  makePersonalSystemSummaryRouteLayer,
  systemSummaryFrom,
} from "./systemSummaryRoute.ts";

const GB = 1024 ** 3;
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (options: {
  auth: "missing" | ReadonlyArray<AuthEnvironmentScope>;
  onRead?: () => void;
}) => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    makePersonalSystemSummaryRouteLayer().pipe(
      Layer.provideMerge(
        Layer.succeed(ServerConfig.ServerConfig, {
          baseDir: NodeOS.tmpdir(),
        } as unknown as ServerConfig.ServerConfig["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(
          HostResources,
          HostResources.of({
            read: Effect.sync(() => {
              options.onRead?.();
              return {
                sampledAt: 0,
                cpuUtilization: 0.123,
                cpuCount: 20,
                availableMemoryBytes: 6 * GB,
                totalMemoryBytes: 16 * GB,
              };
            }),
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth, {
          authenticateWebSocketUpgrade: () =>
            options.auth === "missing"
              ? Effect.fail(new ServerAuthMissingCredentialError({}))
              : Effect.succeed({
                  sessionId: AuthSessionId.make("session-1"),
                  subject: "test",
                  method: "browser-session-cookie",
                  scopes: options.auth,
                }),
        } as unknown as EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return handler;
};

const get = () => new Request(`http://t3.test${PERSONAL_SYSTEM_SUMMARY_PATH}`, { method: "GET" });

describe("the PC summary under the Bots header", () => {
  it("answers CPU, RAM and the data drive's free space", async () => {
    const handler = fixture({ auth: [AuthOrchestrationReadScope] });
    const response = await handler(get());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.cpuPct).toBe(12);
    expect(body.memUsedPct).toBe(63);
    expect(body.memTotalGB).toBe(16);
    expect(typeof body.diskFreeGB).toBe("number");
    expect(typeof body.diskTotalGB).toBe("number");
    expect(Number(body.diskFreeGB)).toBeLessThanOrEqual(Number(body.diskTotalGB));
    expect(typeof body.diskLabel).toBe("string");
  });

  it("refuses a caller with no session and reads nothing", async () => {
    let reads = 0;
    const handler = fixture({ auth: "missing", onRead: () => (reads += 1) });
    const response = await handler(get());
    expect(response.status).toBe(401);
    expect(reads).toBe(0);
  });
});

describe("systemSummaryFrom", () => {
  it("rounds to whole percents and one decimal of GB", () => {
    expect(
      systemSummaryFrom({
        cpuUtilization: 0.996,
        availableMemoryBytes: 1.5 * GB,
        totalMemoryBytes: 16 * GB,
        disk: { label: "C:", freeGB: 120.4, totalGB: 951.6 },
      }),
    ).toEqual({
      cpuPct: 100,
      memUsedPct: 91,
      memUsedGB: 14.5,
      memTotalGB: 16,
      diskLabel: "C:",
      diskFreeGB: 120.4,
      diskTotalGB: 951.6,
    });
  });

  it("leaves out what it could not read", () => {
    expect(
      systemSummaryFrom({
        cpuUtilization: null,
        availableMemoryBytes: 0,
        totalMemoryBytes: 0,
        disk: null,
      }),
    ).toEqual({
      cpuPct: null,
      memUsedPct: null,
      memUsedGB: null,
      memTotalGB: null,
      diskLabel: null,
      diskFreeGB: null,
      diskTotalGB: null,
    });
  });

  it("names a Windows drive by its letter", () => {
    expect(diskLabelOf("C:\\")).toBe("C:");
    expect(diskLabelOf("d:/")).toBe("D:");
    expect(diskLabelOf("/")).toBe("/");
  });
});
