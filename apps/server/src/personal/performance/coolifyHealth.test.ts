// @effect-diagnostics nodeBuiltinImport:off - a real local HTTP server stands in for Coolify.
import * as NodeHttp from "node:http";

import * as Redacted from "effect/Redacted";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  COOLIFY_POLL_MS,
  COOLIFY_STALE_MS,
  fetchCoolifyList,
  makeCoolifyHealthReader,
  mapCoolifyStatus,
  parseCoolifyConfig,
  summariseCoolify,
  type CoolifyFetchList,
  type CoolifyFetchResult,
  type CoolifyListName,
} from "./coolifyHealth.ts";

const TOKEN = "7|cooLifyTokenValue-DO-NOT-LEAK-91af0c";
const token = Redacted.make(TOKEN);

describe("parseCoolifyConfig", () => {
  it("is off with no warning when unset or empty", () => {
    expect(parseCoolifyConfig({})).toEqual({ config: null, warning: null });
    expect(parseCoolifyConfig({ T3CODE_PERSONAL_COOLIFY_URL: " " })).toEqual({
      config: null,
      warning: null,
    });
  });

  it("keeps only the origin of a plain http(s) address", () => {
    expect(
      parseCoolifyConfig({ T3CODE_PERSONAL_COOLIFY_URL: "http://100.117.220.14:8000" }).config,
    ).toEqual({ origin: "http://100.117.220.14:8000" });
    expect(
      parseCoolifyConfig({ T3CODE_PERSONAL_COOLIFY_URL: "https://coolify.example/" }).config,
    ).toEqual({ origin: "https://coolify.example" });
  });

  it.each([
    "100.117.220.14:8000",
    "ftp://100.117.220.14",
    "file:///etc/passwd",
    "http://user:pass@100.117.220.14:8000",
    "http://100.117.220.14:8000/api/v1",
    "http://100.117.220.14:8000/?x=1",
    "http://100.117.220.14:8000/#a",
    "not a url",
  ])("refuses %j", (raw) => {
    expect(parseCoolifyConfig({ T3CODE_PERSONAL_COOLIFY_URL: raw })).toEqual({
      config: null,
      warning: "Coolify health off: T3CODE_PERSONAL_COOLIFY_URL is not a plain http(s) origin",
    });
  });
});

describe("mapCoolifyStatus", () => {
  it.each([
    ["running:healthy", "up"],
    ["running:unknown", "up"],
    ["running", "up"],
    ["Running:Healthy", "up"],
    ["running:unhealthy", "unhealthy"],
    ["degraded:unhealthy", "unhealthy"],
    ["degraded", "unhealthy"],
    ["exited:unhealthy", "down"],
    ["exited:unknown", "down"],
    ["exited", "down"],
    ["stopped", "down"],
    ["dead", "down"],
    ["paused", "down"],
    ["restarting:unknown", "starting"],
    ["starting:unknown", "starting"],
    ["", "unknown"],
    ["weird:thing", "unknown"],
    [null, "unknown"],
    [42, "unknown"],
    [undefined, "unknown"],
  ])("%j is %s", (status, expected) => {
    expect(mapCoolifyStatus(status)).toBe(expected);
  });
});

const EIGHT_APPS = [
  "caltrack",
  "credittracker",
  "homegym",
  "irongymm",
  "matchday",
  "matchday-push",
  "rainhb",
  "stringfit",
].map((name) => ({ name, status: "running:unknown", uuid: `u-${name}`, fqdn: "x" }));
const DB = [{ name: "apps-postgres", status: "running:healthy" }];

describe("summariseCoolify", () => {
  it("counts the live set as 8 of 8 apps up and the database ok", () => {
    expect(summariseCoolify({ applications: EIGHT_APPS, services: [], databases: DB })).toEqual({
      appsUp: 8,
      appsTotal: 8,
      dbsUp: 1,
      dbsTotal: 1,
      problems: [],
    });
  });

  it("names the problems, apps first, and counts services as apps", () => {
    const applications = EIGHT_APPS.map((app) =>
      app.name === "matchday"
        ? { ...app, status: "exited:unhealthy" }
        : app.name === "rainhb"
          ? { ...app, status: "running:unhealthy" }
          : app,
    );
    expect(
      summariseCoolify({
        applications,
        services: [{ name: "umami", status: "restarting:unknown" }],
        databases: [{ name: "apps-postgres", status: "exited" }],
      }),
    ).toEqual({
      appsUp: 6,
      appsTotal: 9,
      dbsUp: 0,
      dbsTotal: 1,
      problems: [
        { kind: "app", name: "matchday", status: "down" },
        { kind: "app", name: "rainhb", status: "unhealthy" },
        { kind: "app", name: "umami", status: "starting" },
        { kind: "db", name: "apps-postgres", status: "down" },
      ],
    });
  });

  it("keeps only clean names and at most 8 problems", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `a${i}`, status: "exited" }));
    const summary = summariseCoolify({
      applications: [
        { name: "bad\u0000name\nhere", status: "exited" },
        { status: "exited" },
        ...many,
      ],
      services: [],
      databases: [],
    })!;
    expect(summary.problems.length).toBe(8);
    expect(summary.problems[0]!.name).toBe("bad name here");
    expect(summary.problems[1]!.name).toBe("unnamed");
    expect(summary.appsTotal).toBe(14);
  });

  it("is null when a list is not a list (an error body)", () => {
    expect(
      summariseCoolify({
        applications: { message: "Unauthenticated." },
        services: [],
        databases: [],
      }),
    ).toBeNull();
  });
});

const lists: Record<CoolifyListName, unknown> = {
  applications: EIGHT_APPS,
  services: [],
  databases: DB,
};

const harness = (
  fetchList: CoolifyFetchList = async (_o, list) => ({ ok: true, body: lists[list] }),
  options: { readToken?: () => Promise<Redacted.Redacted<string> | null> } = {},
) => {
  let clock = 5_000_000;
  const logs: string[] = [];
  let tokenReads = 0;
  const calls: string[] = [];
  const reader = makeCoolifyHealthReader({
    config: { origin: "http://100.117.220.14:8000" },
    fetchList: async (origin, list, value) => {
      calls.push(list);
      return fetchList(origin, list, value);
    },
    now: () => clock,
    log: (line) => logs.push(line),
  });
  const readToken =
    options.readToken ??
    (async () => {
      tokenReads += 1;
      return token;
    });
  return {
    reader,
    logs,
    calls,
    tokenReads: () => tokenReads,
    at: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    touch: async () => {
      reader.touch(clock, readToken);
      await reader.settled();
    },
  };
};

describe("the Coolify reader", () => {
  it("is off and never fetches without a config", async () => {
    const reader = makeCoolifyHealthReader({ config: null });
    expect(reader.enabled).toBe(false);
    reader.touch(0, async () => token);
    expect(reader.current(0)).toBeNull();
  });

  it("is starting until the first round lands, then on", async () => {
    const h = harness();
    expect(h.reader.current(h.at())).toEqual({ state: "starting" });
    await h.touch();
    h.advance(1_500);
    expect(h.reader.current(h.at())).toEqual({
      state: "on",
      ageMs: 1_500,
      appsUp: 8,
      appsTotal: 8,
      dbsUp: 1,
      dbsTotal: 1,
      problems: [],
    });
    expect(h.calls.toSorted()).toEqual(["applications", "databases", "services"]);
  });

  it("fetches at most once every 60 s however often the page asks", async () => {
    const h = harness();
    await h.touch();
    for (let i = 0; i < 5; i += 1) {
      h.advance(10_000);
      await h.touch();
    }
    expect(h.calls.length).toBe(3);
    expect(h.tokenReads()).toBe(1);
    h.advance(COOLIFY_POLL_MS - 50_000);
    await h.touch();
    expect(h.calls.length).toBe(6);
    expect(h.tokenReads()).toBe(2);
  });

  it("never fetches when nobody asks", async () => {
    const h = harness();
    h.advance(10 * COOLIFY_POLL_MS);
    expect(h.calls.length).toBe(0);
  });

  it("starts only one round while one is in flight", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness(async (_o, list) => {
      await gate;
      return { ok: true, body: lists[list] };
    });
    h.reader.touch(h.at(), async () => token);
    h.advance(COOLIFY_POLL_MS * 2);
    h.reader.touch(h.at(), async () => token);
    release();
    await h.reader.settled();
    expect(h.calls.length).toBe(3);
  });

  it.each<[string, CoolifyFetchResult | "throw", string]>([
    ["a 401", { ok: false, reason: "HTTP 401" }, "HTTP 401"],
    ["a timeout", { ok: false, reason: "TimeoutError" }, "TimeoutError"],
    [
      "a non-list body",
      { ok: true, body: { message: "Unauthenticated." } },
      "an answer was not a list",
    ],
    ["a thrown error", "throw", "error"],
  ])("says unreachable, not a count, on %s, and logs it once", async (_name, result, reason) => {
    const h = harness(async (_o, list) => {
      if (list !== "applications") return { ok: true, body: lists[list] };
      if (result === "throw") throw new Error(`boom ${TOKEN}`);
      return result;
    });
    await h.touch();
    expect(h.reader.current(h.at())).toEqual({ state: "unreachable" });
    h.advance(COOLIFY_POLL_MS);
    await h.touch();
    expect(h.reader.current(h.at())).toEqual({ state: "unreachable" });
    expect(h.logs).toEqual([`Coolify health unreachable: ${reason}`]);
    expect(h.logs.join("\n")).not.toContain(TOKEN);
  });

  it("drops an earlier good count as soon as the API stops answering, and recovers", async () => {
    let down = false;
    const h = harness(async (_o, list) =>
      down ? { ok: false, reason: "TypeError" } : { ok: true, body: lists[list] },
    );
    await h.touch();
    expect(h.reader.current(h.at())).toMatchObject({ state: "on", appsUp: 8 });
    down = true;
    h.advance(COOLIFY_POLL_MS);
    await h.touch();
    expect(h.reader.current(h.at())).toEqual({ state: "unreachable" });
    down = false;
    h.advance(COOLIFY_POLL_MS);
    await h.touch();
    expect(h.reader.current(h.at())).toMatchObject({ state: "on", appsUp: 8 });
    expect(h.logs).toEqual([
      "Coolify health unreachable: TypeError",
      "Coolify health reachable again",
    ]);
  });

  it("says unreachable without a fetch when no token is saved or the read fails", async () => {
    for (const readToken of [async () => null, async () => Promise.reject(new Error(TOKEN))]) {
      const h = harness(undefined, { readToken });
      await h.touch();
      expect(h.reader.current(h.at())).toEqual({ state: "unreachable" });
      expect(h.calls).toEqual([]);
      expect(h.logs).toEqual(["Coolify health unreachable: COOLIFY_API_TOKEN is not saved"]);
    }
  });

  it("does not serve a count older than 3 minutes", async () => {
    const h = harness();
    await h.touch();
    h.advance(COOLIFY_STALE_MS);
    expect(h.reader.current(h.at())).toMatchObject({ state: "on" });
    h.advance(1);
    expect(h.reader.current(h.at())).toEqual({ state: "starting" });
  });

  it("never carries the token in any reading", async () => {
    const h = harness(async (_o, list) => ({
      ok: true,
      body: list === "applications" ? [{ name: "a", status: "running", api_token: TOKEN }] : [],
    }));
    await h.touch();
    expect(JSON.stringify(h.reader.current(h.at()))).not.toContain(TOKEN);
  });
});

describe("fetchCoolifyList against a real HTTP server", () => {
  const servers: NodeHttp.Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  const serve = async (
    handler: (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => void,
  ) => {
    const server = NodeHttp.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as { port: number };
    return `http://127.0.0.1:${address.port}`;
  };

  it("sends the token only in the Authorization header of a GET to /api/v1/<list>", async () => {
    const seen: Array<{
      method: string | undefined;
      url: string | undefined;
      auth: string | undefined;
    }> = [];
    const origin = await serve((req, res) => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(EIGHT_APPS));
    });
    const result = await fetchCoolifyList(origin, "applications", token);
    expect(result).toEqual({ ok: true, body: EIGHT_APPS });
    expect(seen).toEqual([{ method: "GET", url: "/api/v1/applications", auth: `Bearer ${TOKEN}` }]);
  });

  it("reports a refused token by its status only", async () => {
    const origin = await serve((_req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ message: "Unauthenticated." }));
    });
    expect(await fetchCoolifyList(origin, "databases", token)).toEqual({
      ok: false,
      reason: "HTTP 401",
    });
  });

  it("refuses a redirect, so the header never goes anywhere else", async () => {
    let elsewhere = 0;
    const other = await serve((_req, res) => {
      elsewhere += 1;
      res.end("[]");
    });
    const origin = await serve((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", `${other}/api/v1/applications`);
      res.end();
    });
    const result = await fetchCoolifyList(origin, "applications", token);
    expect(result.ok).toBe(false);
    expect(elsewhere).toBe(0);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("reports a closed port as unreachable, by error class only", async () => {
    const origin = await serve((_req, res) => res.end("[]"));
    await new Promise<void>((resolve) => servers.splice(0)[0]!.close(() => resolve()));
    const result = await fetchCoolifyList(origin, "services", token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/^[A-Za-z]+$/);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
