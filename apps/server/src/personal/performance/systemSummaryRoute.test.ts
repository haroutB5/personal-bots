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
import { HttpRouter } from "effect/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { EnvironmentAuth, ServerAuthMissingCredentialError } from "../../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../../config.ts";
import { HostResources } from "../../resourceTelemetry/HostResources.ts";
import {
  makeGamingPcReader,
  makeLiveGamingPcReader,
  type GamingPcReader,
  type LinkHandle,
} from "./gamingPc.ts";
import {
  PERSONAL_SYSTEM_SUMMARY_PATH,
  diskLabelOf,
  makePersonalSystemSummaryRouteLayer,
  systemSummaryFrom,
} from "./systemSummaryRoute.ts";

const GB = 1024 ** 3;
const neverLink = (): LinkHandle => {
  throw new Error("no ssh in this test");
};
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (options: {
  auth: "missing" | ReadonlyArray<AuthEnvironmentScope>;
  onRead?: () => void;
  gamingPc?: GamingPcReader;
}) => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    makePersonalSystemSummaryRouteLayer({
      gamingPc:
        options.gamingPc ??
        makeGamingPcReader({ config: null, spawnLink: neverLink, readRigHolder: async () => null }),
    }).pipe(
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
    expect(Array.isArray(body.fans)).toBe(true);
    expect(body.cpuTempC === null || typeof body.cpuTempC === "number").toBe(true);
  });

  it("refuses a caller with no session and reads nothing", async () => {
    let reads = 0;
    const handler = fixture({ auth: "missing", onRead: () => (reads += 1) });
    const response = await handler(get());
    expect(response.status).toBe(401);
    expect(reads).toBe(0);
  });
});

const BODY_KEYS = [
  "cpuPct",
  "cpuTempC",
  "diskFreeGB",
  "diskLabel",
  "diskTempC",
  "diskTotalGB",
  "fans",
  "memTotalGB",
  "memUsedGB",
  "memUsedPct",
];

describe("the gaming PC key in the summary", () => {
  it("is absent, not null, when the feature is not configured, and nothing is spawned", async () => {
    const handler = fixture({ auth: [AuthOrchestrationReadScope] });
    const body = (await (await handler(get())).json()) as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(BODY_KEYS);
  });

  it("is absent when the environment has no host", async () => {
    const reader = makeLiveGamingPcReader({}, () => undefined);
    expect(reader.enabled).toBe(false);
    const handler = fixture({ auth: [AuthOrchestrationReadScope], gamingPc: reader });
    const body = (await (await handler(get())).json()) as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(BODY_KEYS);
  });

  it("is absent and logs once when the host is not a plain alias", async () => {
    const logs: string[] = [];
    const reader = makeLiveGamingPcReader(
      { T3CODE_PERSONAL_GAMINGPC_HOST: "-oProxyCommand=x" },
      (l) => logs.push(l),
    );
    const handler = fixture({ auth: [AuthOrchestrationReadScope], gamingPc: reader });
    const body = (await (await handler(get())).json()) as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(BODY_KEYS);
    expect(logs).toEqual([
      "gaming PC stats off: T3CODE_PERSONAL_GAMINGPC_HOST is not a plain ssh host alias",
    ]);
  });

  it("carries the reader's answer when configured", async () => {
    const view = {
      state: "on",
      cpuPct: 32,
      gpuPct: 4,
      memUsedGB: 12,
      memTotalGB: 16,
      memUsedPct: 75,
      ageMs: 1200,
      users: [{ kind: "game", game: "league-match", label: "League of Legends" }],
    } as const;
    const fake: GamingPcReader = {
      enabled: true,
      touch: () => undefined,
      current: () => view,
      tick: () => undefined,
      stop: () => undefined,
    };
    const handler = fixture({ auth: [AuthOrchestrationReadScope], gamingPc: fake });
    const body = (await (await handler(get())).json()) as Record<string, unknown>;
    expect(body.gamingPc).toEqual(view);
    expect(body.cpuPct).toBe(12);
  });

  it("is null, with the laptop line intact, when the PC has nothing fresh", async () => {
    const fake: GamingPcReader = {
      enabled: true,
      touch: () => undefined,
      current: () => null,
      tick: () => undefined,
      stop: () => undefined,
    };
    const handler = fixture({ auth: [AuthOrchestrationReadScope], gamingPc: fake });
    const body = (await (await handler(get())).json()) as Record<string, unknown>;
    expect(body.gamingPc).toBeNull();
    expect(body.memTotalGB).toBe(16);
  });

  it("answers at once while the link never answers, and spawns one child for many requests", async () => {
    const hosts: string[] = [];
    let kills = 0;
    const link: LinkHandle = {
      onLine: () => undefined,
      onExit: () => undefined,
      kill: () => (kills += 1),
    };
    const reader = makeGamingPcReader({
      config: { host: "gamingpc", rigDir: null },
      spawnLink: (host) => {
        hosts.push(host);
        return link;
      },
      readRigHolder: async () => null,
      startTimer: () => () => undefined,
    });
    const handler = fixture({ auth: [AuthOrchestrationReadScope], gamingPc: reader });
    const first = await handler(get());
    expect(((await first.json()) as Record<string, unknown>).gamingPc).toEqual({
      state: "starting",
    });
    const t0 = performance.now();
    for (let i = 0; i < 5; i += 1) await (await handler(get())).json();
    expect((performance.now() - t0) / 5).toBeLessThan(100);
    expect(hosts).toEqual(["gamingpc"]);
    expect(kills).toBe(0);
  });

  it("does not touch the link for a caller with no session", async () => {
    let touches = 0;
    const fake: GamingPcReader = {
      enabled: true,
      touch: () => (touches += 1),
      current: () => null,
      tick: () => undefined,
      stop: () => undefined,
    };
    const handler = fixture({ auth: "missing", gamingPc: fake });
    expect((await handler(get())).status).toBe(401);
    expect(touches).toBe(0);
  });

  it("stops the link when the server scope ends", async () => {
    let stops = 0;
    const fake: GamingPcReader = {
      enabled: true,
      touch: () => undefined,
      current: () => null,
      tick: () => undefined,
      stop: () => (stops += 1),
    };
    const handler = fixture({ auth: [AuthOrchestrationReadScope], gamingPc: fake });
    await handler(get());
    expect(stops).toBe(0);
    await disposers.splice(0).reduce((p, d) => p.then(d), Promise.resolve());
    expect(stops).toBe(1);
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
        sensors: {
          cpuTempC: 94,
          diskTempC: 39,
          fans: [{ label: "CPU Fan", rpm: 2812 }],
        },
      }),
    ).toEqual({
      cpuPct: 100,
      memUsedPct: 91,
      memUsedGB: 14.5,
      memTotalGB: 16,
      diskLabel: "C:",
      diskFreeGB: 120.4,
      diskTotalGB: 951.6,
      cpuTempC: 94,
      diskTempC: 39,
      fans: [{ label: "CPU Fan", rpm: 2812 }],
    });
  });

  it("leaves out what it could not read", () => {
    expect(
      systemSummaryFrom({
        cpuUtilization: null,
        availableMemoryBytes: 0,
        totalMemoryBytes: 0,
        disk: null,
        sensors: { cpuTempC: null, diskTempC: null, fans: [] },
      }),
    ).toEqual({
      cpuPct: null,
      memUsedPct: null,
      memUsedGB: null,
      memTotalGB: null,
      diskLabel: null,
      diskFreeGB: null,
      diskTotalGB: null,
      cpuTempC: null,
      diskTempC: null,
      fans: [],
    });
  });

  it("names a Windows drive by its letter", () => {
    expect(diskLabelOf("C:\\")).toBe("C:");
    expect(diskLabelOf("d:/")).toBe("D:");
    expect(diskLabelOf("/")).toBe("/");
  });
});
