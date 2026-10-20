import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessIsExecutable, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { isSafeSvg, makeProviderCatalog, type ProviderCatalogOptions } from "./ProviderCatalog.ts";
import { REGISTRY_URL } from "./registry.ts";
import registryFixture from "./fixtures/registry-2026-10-20.json" with { type: "json" };

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const registryText = encodeJson(registryFixture);
const win = "windows-x86_64" as const;
const GOOSE_ARCHIVE =
  "https://github.com/block/goose/releases/download/v1.55.0/goose-x86_64-pc-windows-msvc.zip";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="currentColor" d="M0 0h16v16H0z"/></svg>';

interface Reply {
  readonly status?: number;
  readonly body?: string | Uint8Array;
  readonly headers?: Record<string, string>;
}

type Router = (request: { readonly method: string; readonly url: string }) => Reply;

const harness = (
  router: Router,
  options: Partial<ProviderCatalogOptions> = {},
  stateDirectory?: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir =
      stateDirectory ?? (yield* fs.makeTempDirectoryScoped({ prefix: "hbots-catalog-state-" }));
    const requests: string[] = [];
    const catalog = yield* makeProviderCatalog({
      stateDirectory: stateDir,
      platform: win,
      ...options,
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(HostProcessIsExecutable, false),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push(`${request.method} ${request.url}`);
            const reply = router({ method: request.method, url: request.url });
            const response = HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: reply.status ?? 200, headers: reply.headers ?? {} }),
            );
            const body = typeof reply.body === "string" ? Buffer.from(reply.body) : reply.body;
            return Object.defineProperty(response, "stream", {
              value: body === undefined ? Stream.empty : Stream.make(body),
            });
          }),
        ),
      ),
    );
    return { catalog, fs, path, stateDir, requests };
  });

/** The registry, an icon, and sizes for the archives that exist. */
const normal: Router = ({ method, url }) => {
  if (url === REGISTRY_URL) return { body: registryText };
  if (url.endsWith(".svg")) return { body: SVG };
  if (method === "HEAD")
    return { headers: { "content-length": url === GOOSE_ARCHIVE ? "76483830" : "1000" } };
  return { status: 404 };
};

const settle = Effect.gen(function* () {
  // Background work (size probes, a stale refresh) runs on forked fibers.
  for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
});

describe("isSafeSvg", () => {
  it("accepts a plain one-colour icon", () => {
    expect(isSafeSvg(SVG)).toBe(true);
  });

  it("refuses anything that could run or load something", () => {
    for (const bad of [
      "",
      "<html></html>",
      "<svg><script>alert(1)</script></svg>",
      '<svg onload="x()"></svg>',
      '<svg><a href="https://evil.example"><path/></a></svg>',
      '<svg><use href="https://evil.example/s.svg#x"/></svg>',
      '<svg><image href="data:image/png;base64,AAAA"/></svg>',
      "<svg><foreignObject><div/></foreignObject></svg>",
      "<svg><style>@import url(https://evil.example/x.css);</style></svg>",
      '<svg><path style="fill:url(https://evil.example/p)"/></svg>',
      '<svg><path d="M0"/><!DOCTYPE x [<!ENTITY a "b">]></svg>',
      `<svg>${"x".repeat(70_000)}</svg>`,
    ]) {
      expect(isSafeSvg(bad), bad.slice(0, 40)).toBe(false);
    }
  });

  it("keeps a gradient reference by id but never <use>", () => {
    expect(isSafeSvg('<svg><defs><path id="a" d="M0"/></defs><use href="#a"/></svg>')).toBe(false);
    expect(
      isSafeSvg('<svg><path d="M0"/><linearGradient id="g"/><path fill="url(#g)"/></svg>'),
    ).toBe(true);
  });
});

it.layer(NodeServices.layer)("provider catalog service", (it) => {
  it.effect("fetches the registry on first use and lists built-ins plus registry agents", () =>
    Effect.gen(function* () {
      const { catalog, requests } = yield* harness(normal);
      const result = yield* catalog.list({});
      expect(result.entries.filter((entry) => entry.source === "builtIn")).toHaveLength(7);
      expect(result.entries.filter((entry) => entry.source === "registry")).toHaveLength(35);
      expect(result.entries.slice(0, 3).map((entry) => entry.catalogId)).toEqual([
        "builtin:cursor",
        "gemini",
        "github-copilot-cli",
      ]);
      expect(result.registryStale).toBe(false);
      expect(result.registryFetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(requests.filter((request) => request === `GET ${REGISTRY_URL}`)).toHaveLength(1);
    }),
  );

  it.effect("serves the cached copy without asking again, and probes sizes in the background", () =>
    Effect.gen(function* () {
      const { catalog, requests } = yield* harness(normal);
      yield* catalog.list({});
      yield* settle;
      const second = yield* catalog.list({});
      expect(requests.filter((request) => request === `GET ${REGISTRY_URL}`)).toHaveLength(1);
      const goose = second.entries.find((entry) => entry.catalogId === "goose")!;
      expect(goose.downloadBytes).toBe(76_483_830);
      // Heads were sent for archives only, once each, and never for npm packages.
      const heads = requests.filter((request) => request.startsWith("HEAD "));
      expect(new Set(heads).size).toBe(heads.length);
      expect(heads).toContain(`HEAD ${GOOSE_ARCHIVE}`);
      expect(heads.length).toBeLessThanOrEqual(19);
    }),
  );

  it.effect("keeps the cached copy when a refresh returns something that is not a registry", () =>
    Effect.gen(function* () {
      let broken = false;
      const { catalog, fs, path, stateDir } = yield* harness((request) =>
        broken && request.url === REGISTRY_URL
          ? { body: "<html>maintenance</html>" }
          : normal(request),
      );
      const before = yield* catalog.list({});
      const cacheBefore = yield* fs.readFileString(path.join(stateDir, "provider-catalog.json"));
      broken = true;
      const after = yield* catalog.list({ refresh: true });
      expect(after.entries.map((entry) => entry.catalogId)).toEqual(
        before.entries.map((entry) => entry.catalogId),
      );
      expect(after.registryFetchedAt).toBe(before.registryFetchedAt);
      expect(after.registryStale).toBe(true);
      expect(yield* fs.readFileString(path.join(stateDir, "provider-catalog.json"))).toBe(
        cacheBefore,
      );
    }),
  );

  it.effect("keeps the cached copy when the registry is too large, or the request fails", () =>
    Effect.gen(function* () {
      let mode: "ok" | "huge" | "down" = "ok";
      const { catalog } = yield* harness((request) => {
        if (request.url !== REGISTRY_URL || mode === "ok") return normal(request);
        return mode === "huge" ? { body: "x".repeat(5 * 1024 * 1024) } : { status: 503 };
      });
      const before = yield* catalog.list({});
      for (const next of ["huge", "down"] as const) {
        mode = next;
        const after = yield* catalog.list({ refresh: true });
        expect(after.entries).toHaveLength(before.entries.length);
        expect(after.registryFetchedAt).toBe(before.registryFetchedAt);
      }
    }),
  );

  it.effect("lists only the built-ins when there is no registry copy and no network", () =>
    Effect.gen(function* () {
      const { catalog } = yield* harness(() => ({ status: 503 }));
      const result = yield* catalog.list({});
      expect(result.entries).toHaveLength(7);
      expect(result.registryFetchedAt).toBeNull();
      expect(result.registryStale).toBe(true);
    }),
  );

  it.effect("starts from the copy on disk after a restart, offline", () =>
    Effect.gen(function* () {
      const first = yield* harness(normal);
      const online = yield* first.catalog.list({});
      const second = yield* harness(() => ({ status: 503 }), {}, first.stateDir);
      const offline = yield* second.catalog.list({});
      expect(offline.entries.map((entry) => entry.catalogId)).toEqual(
        online.entries.map((entry) => entry.catalogId),
      );
      expect(offline.registryFetchedAt).toBe(online.registryFetchedAt);
    }),
  );

  it.effect("ignores a damaged cache file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "hbots-catalog-state-" });
      yield* fs.writeFileString(path.join(dir, "provider-catalog.json"), "{broken");
      const { catalog } = yield* harness(normal, {}, dir);
      expect((yield* catalog.list({})).entries.length).toBeGreaterThan(7);
    }),
  );

  it.effect("makes no request when network use is switched off", () =>
    Effect.gen(function* () {
      const { catalog, requests } = yield* harness(normal, {
        networkAllowed: Effect.succeed(false),
      });
      const result = yield* catalog.list({ refresh: true });
      expect(result.entries).toHaveLength(7);
      expect(requests).toEqual([]);
    }),
  );

  it.effect(
    "refreshes in the background when the copy is a day old, and shows it as stale until then",
    () =>
      Effect.gen(function* () {
        const { catalog, requests } = yield* harness(normal);
        yield* catalog.list({});
        yield* TestClock.adjust("25 hours");
        const stale = yield* catalog.list({});
        expect(stale.registryStale).toBe(true);
        yield* settle;
        expect(requests.filter((request) => request === `GET ${REGISTRY_URL}`)).toHaveLength(2);
        expect((yield* catalog.list({})).registryStale).toBe(false);
      }),
  );

  it.effect("waits five minutes before trying again after a failure", () =>
    Effect.gen(function* () {
      const { catalog, requests } = yield* harness(() => ({ status: 503 }));
      yield* catalog.list({});
      yield* catalog.refresh(false);
      yield* TestClock.adjust("4 minutes");
      yield* catalog.refresh(false);
      expect(requests.filter((request) => request.startsWith("GET "))).toHaveLength(1);
      yield* TestClock.adjust("2 minutes");
      yield* catalog.refresh(false);
      expect(requests.filter((request) => request.startsWith("GET "))).toHaveLength(2);
      // An explicit refresh never waits.
      yield* catalog.refresh(true);
      expect(requests.filter((request) => request.startsWith("GET "))).toHaveLength(3);
    }),
  );

  it.effect(
    "takes a newer remote overlay, ignores an older one, and never trusts a broken one",
    () =>
      Effect.gen(function* () {
        const overlayUrl = "https://overlay.example.com/provider-catalog-overlay.json";
        const send = (updatedAt: string) =>
          encodeJson({
            version: 1,
            updatedAt,
            entries: {
              goose: { cost: { kind: "free", label: "Free to use" } },
              "amp-acp": { hidden: true },
            },
          });
        let overlayBody = send("2026-10-21");
        const router: Router = (request) =>
          request.url === overlayUrl ? { body: overlayBody } : normal(request);
        const { catalog } = yield* harness(router, { overlayUrl });
        const newer = yield* catalog.list({});
        expect(newer.entries.find((entry) => entry.catalogId === "goose")!.cost).toEqual({
          kind: "free",
          label: "Free to use",
          detail: null,
        });
        expect(newer.entries.some((entry) => entry.catalogId === "amp-acp")).toBe(false);
        // The bundled overlay (2026-10-20) outranks an older remote copy.
        overlayBody = send("2026-10-01");
        const second = yield* harness(router, { overlayUrl });
        const older = yield* second.catalog.list({});
        expect(older.entries.some((entry) => entry.catalogId === "amp-acp")).toBe(true);
        // A broken overlay changes nothing.
        overlayBody = "{broken";
        const third = yield* harness(router, { overlayUrl });
        const broken = yield* third.catalog.list({});
        expect(broken.entries.find((entry) => entry.catalogId === "goose")!.cost.kind).toBe(
          "unknown",
        );
      }),
  );

  it.effect("tells the installer what a catalogue id means", () =>
    Effect.gen(function* () {
      const { catalog } = yield* harness(normal);
      yield* catalog.list({});
      expect(yield* catalog.installPlan("gemini")).toMatchObject({
        kind: "npm",
        name: "@google/gemini-cli",
      });
      expect(yield* catalog.installPlan("goose")).toMatchObject({ kind: "binary" });
      expect(yield* catalog.installPlan("junie")).toEqual({
        kind: "unsupported",
        reason: "noChecksum",
      });
      expect(yield* catalog.installPlan("fast-agent")).toEqual({
        kind: "unsupported",
        reason: "needsUv",
      });
      expect(yield* catalog.installPlan("no-such-agent")).toBeNull();
      expect((yield* catalog.installRequest("gemini"))?.overlay?.signInLabel).toBe(
        "Google account or API key",
      );
      expect((yield* catalog.installRequest("goose"))?.agent.version).toBe("1.55.0");
      expect(yield* catalog.installRequest("builtin:cursor")).toBeNull();
    }),
  );

  it.effect(
    "uses only the bundled overlay when no remote overlay is configured, including after restart",
    () =>
      Effect.gen(function* () {
        const overlayUrl = "https://overlay.example.com/catalog.json";
        const first = yield* harness(
          (request) =>
            request.url === overlayUrl
              ? {
                  body: encodeJson({
                    version: 1,
                    updatedAt: "2099-01-01",
                    entries: { "amp-acp": { hidden: true } },
                  }),
                }
              : normal(request),
          { overlayUrl },
        );
        expect(
          (yield* first.catalog.list({})).entries.some((entry) => entry.catalogId === "amp-acp"),
        ).toBe(false);
        const second = yield* harness(
          normal,
          { networkAllowed: Effect.succeed(false) },
          first.stateDir,
        );
        expect(
          (yield* second.catalog.list({})).entries.some((entry) => entry.catalogId === "amp-acp"),
        ).toBe(true);
        expect(yield* second.catalog.icon("amp-acp")).toBeNull();
        expect(second.requests).toEqual([]);
      }),
  );

  it.effect("gives the install sheet its facts, and none for what cannot be installed", () =>
    Effect.gen(function* () {
      const { catalog } = yield* harness(normal);
      yield* catalog.list({});
      yield* settle;
      expect(yield* catalog.installFacts("goose")).toEqual({
        catalogId: "goose",
        version: "1.55.0",
        distribution: { kind: "binary", label: "GitHub release · block/goose" },
        downloadBytes: 76_483_830,
        requiredBytes: Math.ceil(76_483_830 * 2.5),
        sha256Checked: true,
        host: "github.com",
        runsInstallScripts: false,
      });
      expect(yield* catalog.installFacts("gemini")).toEqual({
        catalogId: "gemini",
        version: "0.64.0",
        distribution: { kind: "npm", label: "npm · @google/gemini-cli" },
        downloadBytes: null,
        requiredBytes: 600 * 1024 * 1024,
        sha256Checked: false,
        host: "registry.npmjs.org",
        runsInstallScripts: true,
      });
      expect(yield* catalog.installFacts("junie")).toBeNull();
      expect(yield* catalog.installFacts("fast-agent")).toBeNull();
      expect(yield* catalog.installFacts("nope")).toBeNull();
    }),
  );

  it.effect("marks agents the user already added", () =>
    Effect.gen(function* () {
      const { catalog } = yield* harness(normal, {
        added: Effect.succeed(new Map([["gemini", "gemini"]])),
      });
      const result = yield* catalog.list({});
      expect(result.entries.find((entry) => entry.catalogId === "gemini")!.added).toEqual({
        instanceId: "gemini",
      });
    }),
  );
});

it.layer(NodeServices.layer)("provider catalog icons", (it) => {
  it.effect("fetches an icon once, keeps it on disk, and serves reviewed SVG only", () =>
    Effect.gen(function* () {
      const { catalog, requests, fs, path, stateDir } = yield* harness(normal);
      yield* catalog.list({});
      expect(yield* catalog.icon("gemini")).toBe(SVG);
      expect(yield* catalog.icon("gemini")).toBe(SVG);
      expect(requests.filter((request) => request.endsWith("/gemini.svg"))).toHaveLength(1);
      expect(
        yield* fs.readFileString(path.join(stateDir, "provider-catalog-icons", "gemini.svg")),
      ).toBe(SVG);
      // A built-in uses its registry copy's icon.
      expect(yield* catalog.icon("builtin:claudeAgent")).toBe(SVG);
      expect(requests.some((request) => request.endsWith("/claude-acp.svg"))).toBe(true);
    }),
  );

  it.effect("serves an icon from disk after a restart without asking the CDN", () =>
    Effect.gen(function* () {
      const first = yield* harness(normal);
      yield* first.catalog.list({});
      yield* first.catalog.icon("goose");
      const second = yield* harness(() => ({ status: 503 }), {}, first.stateDir);
      yield* second.catalog.list({});
      expect(yield* second.catalog.icon("goose")).toBe(SVG);
      expect(second.requests.some((request) => request.endsWith(".svg"))).toBe(false);
    }),
  );

  it.effect("refuses an unsafe icon, and remembers it so it is not fetched on every render", () =>
    Effect.gen(function* () {
      const { catalog, requests, fs, path, stateDir } = yield* harness((request) =>
        request.url.endsWith("/goose.svg")
          ? { body: "<svg><script>alert(1)</script></svg>" }
          : normal(request),
      );
      yield* catalog.list({});
      expect(yield* catalog.icon("goose")).toBeNull();
      expect(yield* catalog.icon("goose")).toBeNull();
      expect(requests.filter((request) => request.endsWith("/goose.svg"))).toHaveLength(1);
      expect(yield* fs.exists(path.join(stateDir, "provider-catalog-icons", "goose.svg"))).toBe(
        false,
      );
    }),
  );

  it.effect("has no icon for an unknown id, a missing icon, or an oversized one", () =>
    Effect.gen(function* () {
      const { catalog } = yield* harness((request) =>
        request.url.endsWith("/goose.svg")
          ? { body: "x".repeat(100_000) }
          : request.url.endsWith("/amp-acp.svg")
            ? { status: 404 }
            : normal(request),
      );
      yield* catalog.list({});
      expect(yield* catalog.icon("nope")).toBeNull();
      expect(yield* catalog.icon("builtin:deepseek")).toBeNull();
      expect(yield* catalog.icon("goose")).toBeNull();
      expect(yield* catalog.icon("amp-acp")).toBeNull();
    }),
  );
});
