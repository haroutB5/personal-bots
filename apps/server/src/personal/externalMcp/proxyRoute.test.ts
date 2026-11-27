// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PERSONAL_EXTERNAL_MCP_ROUTE_PREFIX,
  PersonalBotId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter } from "effect/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import {
  makeSensitiveExposureStore,
  rootExposureKey,
  threadExposureKey,
} from "../browser/sensitiveExposureStore.ts";
import { secretRedactor } from "../secrets/secretRedaction.ts";
import * as PersonalExternalMcpRepository from "./PersonalExternalMcpRepository.ts";
import {
  PersonalExternalMcpService,
  make as makeExternalMcpService,
} from "./PersonalExternalMcpService.ts";
import {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  MAX_RESPONSE_BODY_BYTES,
  makePersonalExternalMcpProxyRouteLayer,
  type PersonalExternalMcpProxyOptions,
} from "./proxyRoute.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  secretRedactor.clear();
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});

interface RecordedUpstreamRequest {
  readonly method: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

const startFakeUpstreamMcp = async () => {
  const requests: Array<RecordedUpstreamRequest> = [];
  const server = NodeHttp.createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method ?? "GET", headers: req.headers, body });

      if (req.method === "DELETE") {
        res.writeHead(204, { "mcp-session-id": "upstream-sess-1" });
        res.end();
        return;
      }

      if (req.method === "GET" || req.headers.accept?.includes("text/event-stream-only")) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "mcp-session-id": "upstream-sess-1",
          "mcp-protocol-version": "2025-03-26",
        });
        res.write('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"streamed":true}}\n\n');
        res.end();
        return;
      }

      res.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "upstream-sess-1",
        "mcp-protocol-version": "2025-03-26",
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { ok: true, echoedBody: body },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as NodeNet.AddressInfo;
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  );
  return { url: `http://127.0.0.1:${address.port}/mcp`, requests };
};

const makeInMemorySecretStoreLayer = () => {
  const map = new Map<string, Uint8Array>();
  return Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: (name) => Effect.sync(() => Option.fromNullishOr(map.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        map.set(name, Uint8Array.from(value));
      }),
    create: (name, value) =>
      Effect.sync(() => {
        map.set(name, Uint8Array.from(value));
      }),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = map.get(name);
        if (existing) return existing;
        const created = new Uint8Array(bytes);
        map.set(name, created);
        return created;
      }),
    remove: (name) =>
      Effect.sync(() => {
        map.delete(name);
      }),
  });
};

const setupFixture = async (
  envProvider: () => NodeJS.ProcessEnv = () => ({}),
  proxyOptions: Omit<PersonalExternalMcpProxyOptions, "env"> = {},
) => {
  const upstream = await startFakeUpstreamMcp();
  const tokens = new Map<string, ThreadId>();
  const registryLayer = Layer.succeed(McpSessionRegistry.McpSessionRegistry, {
    issue: () => Effect.die("unused"),
    resolve: (rawToken) =>
      Effect.sync(() => {
        const threadId = tokens.get(rawToken);
        if (threadId === undefined) return undefined;
        return {
          environmentId: EnvironmentId.make("env-test"),
          requestNamespace: "ns-1",
          thread: {
            threadId,
            providerSessionId: "ps-1",
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            subagent: false,
          },
          client: undefined,
          capabilities: new Set(["orchestration", "bots", "personal"]),
          issuedAt: Date.now(),
        };
      }),
    touch: () => Effect.void,
    revokeProviderSession: () => Effect.void,
    revokeThread: () => Effect.void,
    revokeAll: Effect.void,
  });

  const baseLayer = Layer.mergeAll(
    SqlitePersistence.layerMemory,
    NodeHttpPlatform.layer,
    NodeServices.layer,
    NodeCrypto.layer,
    makeInMemorySecretStoreLayer(),
    registryLayer,
  );
  const reposLayer = Layer.mergeAll(
    PersonalExternalMcpRepository.layer,
    PersonalBotRepository.layer,
  ).pipe(Layer.provideMerge(baseLayer));
  const serviceLayer = Layer.effect(
    PersonalExternalMcpService,
    makeExternalMcpService({ env: envProvider }),
  ).pipe(Layer.provideMerge(reposLayer));

  let runEffect!: <A, E>(
    effect: Effect.Effect<
      A,
      E,
      SqlClient.SqlClient | PersonalBotRepository.PersonalBotRepository | PersonalExternalMcpService
    >,
  ) => Promise<A>;

  // Build one shared runtime by capturing services in a Layer.effect helper.
  let capturedSql!: SqlClient.SqlClient;
  let capturedBots!: PersonalBotRepository.PersonalBotRepository["Service"];
  let capturedExternalMcp!: PersonalExternalMcpService["Service"];

  const captureLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      capturedSql = yield* SqlClient.SqlClient;
      capturedBots = yield* PersonalBotRepository.PersonalBotRepository;
      capturedExternalMcp = yield* PersonalExternalMcpService;
    }),
  ).pipe(Layer.provideMerge(serviceLayer));

  const { handler, dispose } = HttpRouter.toWebHandler(
    makePersonalExternalMcpProxyRouteLayer({ env: envProvider, ...proxyOptions }).pipe(
      Layer.provideMerge(captureLayer),
    ),
    { disableLogger: true },
  );
  cleanups.push(dispose);

  // Trigger lazy layer initialization with a quick 401 probe.
  await handler(
    new Request(`http://t3.test${PERSONAL_EXTERNAL_MCP_ROUTE_PREFIX}/init/mcp`, { method: "POST" }),
  );

  runEffect = (effect) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(SqlClient.SqlClient, capturedSql),
        Effect.provideService(PersonalBotRepository.PersonalBotRepository, capturedBots),
        Effect.provideService(PersonalExternalMcpService, capturedExternalMcp),
      ),
    );

  // Seed bot + linked thread + server.
  const botId = PersonalBotId.make("bot-neon");
  const threadId = ThreadId.make("thread-bot-1");
  const nonPersonalThreadId = ThreadId.make("thread-regular-1");
  const server = await runEffect(
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* capturedBots.createBot({
        botId,
        name: "Neon",
        title: "Neon",
        description: "",
        instructions: "",
        avatarShape: "blob",
        avatarColor: "#3B82F6",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        },
        team: "work",
        lead: true,
        pinned: false,
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      });
      yield* capturedBots.insertThreadLink({ botId, threadId, createdAt: now });
      return yield* capturedExternalMcp.create({
        slug: "executor",
        displayName: "Executor",
        url: upstream.url,
        scope: "team",
        scopeId: "work",
        bearerToken: "upstream-executor-secret-98765",
      });
    }),
  );

  tokens.set("t3-bot-token", threadId);
  tokens.set("t3-regular-token", nonPersonalThreadId);

  const proxyUrl = `http://t3.test${PERSONAL_EXTERNAL_MCP_ROUTE_PREFIX}/${server.serverId}/mcp`;
  return { upstream, handler, runEffect, server, botId, threadId, proxyUrl, tokens };
};

describe("external MCP reverse proxy route", () => {
  it("proxies POST/GET/DELETE with upstream Bearer token injection and header forwarding", async () => {
    const { upstream, handler, proxyUrl } = await setupFixture();

    const postRes = await handler(
      new Request(proxyUrl, {
        method: "POST",
        headers: {
          authorization: "Bearer t3-bot-token",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": "client-sess-42",
          "mcp-protocol-version": "2025-03-26",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );

    expect(postRes.status).toBe(200);
    expect(postRes.headers.get("mcp-session-id")).toBe("upstream-sess-1");
    expect(postRes.headers.get("mcp-protocol-version")).toBe("2025-03-26");
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.headers.authorization).toBe(
      "Bearer upstream-executor-secret-98765",
    );
    expect(upstream.requests[0]?.headers["mcp-session-id"]).toBe("client-sess-42");

    // SSE GET round-trip.
    const getRes = await handler(
      new Request(proxyUrl, {
        method: "GET",
        headers: {
          authorization: "Bearer t3-bot-token",
          accept: "text/event-stream",
        },
      }),
    );
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toContain("text/event-stream");
    expect(await getRes.text()).toContain('"streamed":true');

    // DELETE round-trip.
    const delRes = await handler(
      new Request(proxyUrl, {
        method: "DELETE",
        headers: {
          authorization: "Bearer t3-bot-token",
          "mcp-session-id": "upstream-sess-1",
        },
      }),
    );
    expect(delRes.status).toBe(204);
  });

  it("rejects unauthenticated requests (401) and non-personal threads (403)", async () => {
    const { upstream, handler, proxyUrl } = await setupFixture();

    const noAuth = await handler(new Request(proxyUrl, { method: "POST", body: "{}" }));
    expect(noAuth.status).toBe(401);

    const nonPersonal = await handler(
      new Request(proxyUrl, {
        method: "POST",
        headers: { authorization: "Bearer t3-regular-token", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(nonPersonal.status).toBe(403);
    expect(upstream.requests).toHaveLength(0);
  });

  it("blocks calls with HTTP 403 when a sensitive site is open in the thread or root task", async () => {
    const { upstream, handler, runEffect, threadId, proxyUrl } = await setupFixture();

    await runEffect(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* makeSensitiveExposureStore(sql).record(
          [threadExposureKey(threadId)],
          "source",
          "https://bank.example",
        );
      }),
    );

    const blocked = await handler(
      new Request(proxyUrl, {
        method: "POST",
        headers: { authorization: "Bearer t3-bot-token", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }),
      }),
    );
    expect(blocked.status).toBe(403);
    const payload = (await blocked.json()) as { readonly error?: { readonly message?: string } };
    expect(payload.error?.message).toBe(
      "Blocked: a sensitive site is open in this chat, so external MCP servers cannot be called.",
    );
    expect(upstream.requests).toHaveLength(0);

    // Also verify root-task taint blocks even when thread key itself is clean.
    const {
      upstream: upstream2,
      handler: handler2,
      runEffect: runEffect2,
      botId: botId2,
      threadId: threadId2,
      proxyUrl: proxyUrl2,
    } = await setupFixture();
    await runEffect2(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO personal_tasks (
            task_id, root_task_id, parent_task_id, bot_id, thread_id,
            title, objective, acceptance_criteria, expected_output,
            status, source, idempotency_key, depth, max_depth, max_children,
            created_at, updated_at
          ) VALUES (
            'task-child-1', 'task-root-1', NULL, ${botId2}, ${threadId2},
            't', 'o', '', '', 'running', 'delegated', 'idem-1', 0, 2, 5,
            ${now}, ${now}
          )
        `;
        yield* makeSensitiveExposureStore(sql).record(
          [rootExposureKey("task-root-1")],
          "source",
          "https://mail.example",
        );
      }),
    );
    const blockedRoot = await handler2(
      new Request(proxyUrl2, {
        method: "POST",
        headers: { authorization: "Bearer t3-bot-token", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      }),
    );
    expect(blockedRoot.status).toBe(403);
    expect(upstream2.requests).toHaveLength(0);
  });

  it("redacts saved personal secrets from outbound JSON bodies before forwarding upstream", async () => {
    const { upstream, handler, proxyUrl } = await setupFixture();
    secretRedactor.set("GITHUB_TOKEN", "ghp_super_secret_value_123456");

    const res = await handler(
      new Request(proxyUrl, {
        method: "POST",
        headers: {
          authorization: "Bearer t3-bot-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { arguments: { token: "ghp_super_secret_value_123456" } },
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.body).toContain("[secret GITHUB_TOKEN]");
    expect(upstream.requests[0]?.body).not.toContain("ghp_super_secret_value_123456");
  });

  it("returns HTTP 503 when kill switch T3CODE_PERSONAL_EXTERNAL_MCP=off is set", async () => {
    let env: NodeJS.ProcessEnv = {};
    const { upstream, handler, proxyUrl } = await setupFixture(() => env);

    env = { T3CODE_PERSONAL_EXTERNAL_MCP: "off" };
    const res = await handler(
      new Request(proxyUrl, {
        method: "POST",
        headers: { authorization: "Bearer t3-bot-token", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(503);
    expect(upstream.requests).toHaveLength(0);
  });

  it("refuses upstream redirects (redirect: error) and returns HTTP 502", async () => {
    let seenRedirect: RequestInit["redirect"];
    const redirectingServer = NodeHttp.createServer((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:9/evil" });
      res.end();
    });
    await new Promise<void>((resolve) => redirectingServer.listen(0, "127.0.0.1", resolve));
    const redirectAddr = redirectingServer.address() as NodeNet.AddressInfo;
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) =>
          redirectingServer.close((err) => (err ? reject(err) : resolve())),
        ),
    );

    const { handler, runEffect, server, proxyUrl } = await setupFixture(() => ({}), {
      fetchImpl: (input, init) => {
        seenRedirect = init?.redirect;
        return globalThis.fetch(input, init);
      },
    });
    await runEffect(
      Effect.gen(function* () {
        const svc = yield* PersonalExternalMcpService;
        yield* svc.update({
          serverId: server.serverId,
          url: `http://127.0.0.1:${redirectAddr.port}/mcp`,
        });
      }),
    );

    const res = await handler(
      new Request(proxyUrl, {
        method: "POST",
        headers: { authorization: "Bearer t3-bot-token", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(seenRedirect).toBe("error");
    expect(res.status).toBe(502);
    const payload = (await res.json()) as { readonly error?: { readonly message?: string } };
    expect(payload.error?.message?.toLowerCase()).toContain("redirect");
  });

  it("times out stalled upstream requests and returns HTTP 502", async () => {
    expect(DEFAULT_UPSTREAM_TIMEOUT_MS).toBe(60_000);
    const { handler, proxyUrl } = await setupFixture(() => ({}), {
      upstreamTimeoutMs: 50,
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError"));
          });
        }),
    });

    const res = await handler(
      new Request(proxyUrl, {
        method: "POST",
        headers: { authorization: "Bearer t3-bot-token", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(502);
    const payload = (await res.json()) as { readonly error?: { readonly message?: string } };
    expect(payload.error?.message).toContain("timed out");
  });

  it("bounds non-SSE upstream response bodies to 4 MiB and returns HTTP 502 when exceeded", async () => {
    expect(MAX_RESPONSE_BODY_BYTES).toBe(4 * 1024 * 1024);
    const { handler, proxyUrl } = await setupFixture(() => ({}), {
      maxResponseBytes: 128,
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(80).fill(65));
              controller.enqueue(new Uint8Array(80).fill(66));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const res = await handler(
      new Request(proxyUrl, {
        method: "POST",
        headers: { authorization: "Bearer t3-bot-token", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(502);
    const payload = (await res.json()) as { readonly error?: { readonly message?: string } };
    expect(payload.error?.message).toContain("exceeds maximum size");
  });

  it("scrubs saved personal secrets and upstream bearer token from JSON and SSE upstream responses", async () => {
    secretRedactor.set("OPENAI_KEY", "sk-live-secret-9876543210");
    let sseMode = false;
    const { handler, proxyUrl } = await setupFixture(() => ({}), {
      fetchImpl: async () => {
        if (sseMode) {
          const encoder = new TextEncoder();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                // Split both the saved secret and upstream bearer token across chunk boundaries.
                controller.enqueue(encoder.encode('event: message\ndata: {"k":"sk-live-sec'));
                controller.enqueue(encoder.encode('ret-9876543210","tok":"upstream-executor-'));
                controller.enqueue(encoder.encode('secret-98765"}\n\n'));
                controller.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              leakedSecret: "sk-live-secret-9876543210",
              leakedBearer: "upstream-executor-secret-98765",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    // Non-SSE JSON response
    sseMode = false;
    const jsonRes = await handler(
      new Request(proxyUrl, {
        method: "POST",
        headers: { authorization: "Bearer t3-bot-token", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(jsonRes.status).toBe(200);
    const jsonBody = await jsonRes.text();
    expect(jsonBody).toContain("[secret OPENAI_KEY]");
    expect(jsonBody).toContain("[redacted]");
    expect(jsonBody).not.toContain("sk-live-secret-9876543210");
    expect(jsonBody).not.toContain("upstream-executor-secret-98765");

    // SSE response across chunk boundaries
    sseMode = true;
    const sseRes = await handler(
      new Request(proxyUrl, {
        method: "GET",
        headers: { authorization: "Bearer t3-bot-token", accept: "text/event-stream" },
      }),
    );
    expect(sseRes.status).toBe(200);
    const sseBody = await sseRes.text();
    expect(sseBody).toContain("[secret OPENAI_KEY]");
    expect(sseBody).toContain("[redacted]");
    expect(sseBody).not.toContain("sk-live-secret-9876543210");
    expect(sseBody).not.toContain("upstream-executor-secret-98765");
  });
});
