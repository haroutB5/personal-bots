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
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { HttpRouter } from "effect/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { EnvironmentAuth, ServerAuthMissingCredentialError } from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { HostResources } from "../../resourceTelemetry/HostResources.ts";
import * as PersonalSecretRepository from "../secrets/PersonalSecretRepository.ts";
import {
  makeCoolifyHealthReader,
  makeLiveCoolifyHealthReader,
  type CoolifyFetchList,
  type CoolifyHealthReader,
} from "./coolifyHealth.ts";
import {
  makeLiveServerStatsReader,
  makeServerStatsReader,
  type LinkHandle,
  type ServerStatsReader,
} from "./serverStats.ts";
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

/** A token that must never leave the server: not in a body, not in a log. */
const TOKEN = "7|cooLifyTokenValue-DO-NOT-LEAK-91af0c";

const secretLayers = (saved: string | null) =>
  Layer.mergeAll(
    Layer.succeed(ServerSecretStore.ServerSecretStore, {
      get: (name: string) =>
        Effect.succeed(
          saved !== null && name === "personal-secret-COOLIFY_API_TOKEN"
            ? Option.some(new TextEncoder().encode(`${saved}\n`))
            : Option.none(),
        ),
    } as unknown as ServerSecretStore.ServerSecretStore["Service"]),
    Layer.succeed(PersonalSecretRepository.PersonalSecretRepository, {
      listByStatus: () => Effect.succeed([]),
    } as unknown as PersonalSecretRepository.PersonalSecretRepository["Service"]),
  );

const fixture = (options: {
  auth: "missing" | ReadonlyArray<AuthEnvironmentScope>;
  onRead?: () => void;
  serverStats?: ServerStatsReader;
  serverApps?: CoolifyHealthReader;
  savedToken?: string | null;
}) => {
  const { handler, dispose } = HttpRouter.toWebHandler(
    makePersonalSystemSummaryRouteLayer({
      serverStats:
        options.serverStats ?? makeServerStatsReader({ config: null, spawnLink: neverLink }),
      serverApps: options.serverApps ?? makeCoolifyHealthReader({ config: null }),
    }).pipe(
      Layer.provideMerge(
        secretLayers(options.savedToken === undefined ? TOKEN : options.savedToken),
      ),
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

const fakeStats = (overrides: Partial<ServerStatsReader> = {}): ServerStatsReader => ({
  enabled: true,
  touch: () => undefined,
  current: () => null,
  tick: () => undefined,
  stop: () => undefined,
  ...overrides,
});

describe("the server key in the summary", () => {
  it("is absent, not null, when the feature is not configured, and nothing is spawned", async () => {
    const handler = fixture({ auth: [AuthOrchestrationReadScope] });
    const body = (await (await handler(get())).json()) as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(BODY_KEYS);
  });

  it("is absent when the environment has no host, and the old gaming PC variable is ignored", async () => {
    const reader = makeLiveServerStatsReader(
      { T3CODE_PERSONAL_GAMINGPC_HOST: "gamingpc", T3CODE_PERSONAL_GAMINGPC_RIG_DIR: "/tmp" },
      () => undefined,
    );
    expect(reader.enabled).toBe(false);
    const handler = fixture({ auth: [AuthOrchestrationReadScope], serverStats: reader });
    const body = (await (await handler(get())).json()) as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(BODY_KEYS);
    expect(JSON.stringify(body)).not.toContain("gamingPc");
  });

  it("is absent and logs once when the host is not a plain alias", async () => {
    const logs: string[] = [];
    const reader = makeLiveServerStatsReader(
      { T3CODE_PERSONAL_SERVER_STATS_HOST: "-oProxyCommand=x" },
      (l) => logs.push(l),
    );
    const handler = fixture({ auth: [AuthOrchestrationReadScope], serverStats: reader });
    const body = (await (await handler(get())).json()) as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(BODY_KEYS);
    expect(logs).toEqual([
      "server stats off: T3CODE_PERSONAL_SERVER_STATS_HOST is not a plain ssh host alias",
    ]);
  });

  it("carries the reader's answer when configured", async () => {
    const view = {
      state: "on",
      cpuPct: 12,
      memUsedGB: 5.4,
      memTotalGB: 15.3,
      memUsedPct: 35,
      diskFreeGB: 238,
      diskTotalGB: 474.9,
      ageMs: 1200,
    } as const;
    const handler = fixture({
      auth: [AuthOrchestrationReadScope],
      serverStats: fakeStats({ current: () => view }),
    });
    const body = (await (await handler(get())).json()) as Record<string, unknown>;
    expect(body.server).toEqual(view);
    expect(body.cpuPct).toBe(12);
  });

  it("is null, with the laptop line intact, when the server has nothing fresh", async () => {
    const handler = fixture({ auth: [AuthOrchestrationReadScope], serverStats: fakeStats() });
    const body = (await (await handler(get())).json()) as Record<string, unknown>;
    expect(body.server).toBeNull();
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
    const reader = makeServerStatsReader({
      config: { host: "omarchy-old" },
      spawnLink: (host) => {
        hosts.push(host);
        return link;
      },
      startTimer: () => () => undefined,
    });
    const handler = fixture({ auth: [AuthOrchestrationReadScope], serverStats: reader });
    const first = await handler(get());
    expect(((await first.json()) as Record<string, unknown>).server).toEqual({
      state: "starting",
    });
    const t0 = performance.now();
    for (let i = 0; i < 5; i += 1) await (await handler(get())).json();
    expect((performance.now() - t0) / 5).toBeLessThan(100);
    expect(hosts).toEqual(["omarchy-old"]);
    expect(kills).toBe(0);
  });

  it("does not touch the link or Coolify for a caller with no session", async () => {
    let touches = 0;
    let appTouches = 0;
    const apps: CoolifyHealthReader = {
      enabled: true,
      touch: () => (appTouches += 1),
      current: () => null,
      settled: () => Promise.resolve(),
    };
    const handler = fixture({
      auth: "missing",
      serverStats: fakeStats({ touch: () => (touches += 1) }),
      serverApps: apps,
    });
    expect((await handler(get())).status).toBe(401);
    expect(touches).toBe(0);
    expect(appTouches).toBe(0);
  });

  it("stops the link when the server scope ends", async () => {
    let stops = 0;
    const handler = fixture({
      auth: [AuthOrchestrationReadScope],
      serverStats: fakeStats({ stop: () => (stops += 1) }),
    });
    await handler(get());
    expect(stops).toBe(0);
    await disposers.splice(0).reduce((p, d) => p.then(d), Promise.resolve());
    expect(stops).toBe(1);
  });
});

const LISTS = {
  applications: [
    { name: "caltrack", status: "running:unknown", uuid: "a1" },
    { name: "matchday", status: "exited:unhealthy", uuid: "a2" },
  ],
  services: [],
  databases: [{ name: "apps-postgres", status: "running:healthy" }],
} as const;

describe("the serverApps key in the summary", () => {
  it("is absent when T3CODE_PERSONAL_COOLIFY_URL is unset, and no token is read", async () => {
    const reader = makeLiveCoolifyHealthReader({}, () => undefined);
    expect(reader.enabled).toBe(false);
    const handler = fixture({ auth: [AuthOrchestrationReadScope], serverApps: reader });
    const body = (await (await handler(get())).json()) as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(BODY_KEYS);
  });

  it("reads the saved token for the fetch, and the token is never in a response", async () => {
    const seen: string[] = [];
    const fetchList: CoolifyFetchList = async (origin, list, token) => {
      seen.push(`${origin} ${list} ${Redacted.value(token)}`);
      return { ok: true, body: LISTS[list] };
    };
    const reader = makeCoolifyHealthReader({
      config: { origin: "http://100.117.220.14:8000" },
      fetchList,
    });
    const handler = fixture({ auth: [AuthOrchestrationReadScope], serverApps: reader });
    const first = await (await handler(get())).text();
    expect(JSON.parse(first).serverApps).toEqual({ state: "starting" });
    await reader.settled();
    const second = await (await handler(get())).text();
    expect(JSON.parse(second).serverApps).toMatchObject({
      state: "on",
      appsUp: 1,
      appsTotal: 2,
      dbsUp: 1,
      dbsTotal: 1,
      problems: [{ kind: "app", name: "matchday", status: "down" }],
    });
    expect(seen.toSorted()).toEqual([
      `http://100.117.220.14:8000 applications ${TOKEN}`,
      `http://100.117.220.14:8000 databases ${TOKEN}`,
      `http://100.117.220.14:8000 services ${TOKEN}`,
    ]);
    for (const text of [first, second]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("cooLifyToken");
      expect(text).not.toContain("Bearer");
    }
  });

  it("says unreachable, with no token in the body or the log, when a fetch throws with the token in its message", async () => {
    const logs: string[] = [];
    const reader = makeCoolifyHealthReader({
      config: { origin: "http://100.117.220.14:8000" },
      fetchList: async (_origin, _list, token) => {
        throw new Error(`connect failed for Bearer ${Redacted.value(token)}`);
      },
      log: (line) => logs.push(line),
    });
    const handler = fixture({ auth: [AuthOrchestrationReadScope], serverApps: reader });
    await handler(get());
    await reader.settled();
    const text = await (await handler(get())).text();
    expect(JSON.parse(text).serverApps).toEqual({ state: "unreachable" });
    expect(text).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(logs).toEqual(["Coolify health unreachable: error"]);
  });

  it("says unreachable when no token is saved, and never fetches", async () => {
    let fetches = 0;
    const logs: string[] = [];
    const reader = makeCoolifyHealthReader({
      config: { origin: "http://100.117.220.14:8000" },
      fetchList: async () => {
        fetches += 1;
        return { ok: true, body: [] };
      },
      log: (line) => logs.push(line),
    });
    const handler = fixture({
      auth: [AuthOrchestrationReadScope],
      serverApps: reader,
      savedToken: null,
    });
    await handler(get());
    await reader.settled();
    const body = (await (await handler(get())).json()) as Record<string, unknown>;
    expect(body.serverApps).toEqual({ state: "unreachable" });
    expect(fetches).toBe(0);
    expect(logs).toEqual(["Coolify health unreachable: COOLIFY_API_TOKEN is not saved"]);
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
