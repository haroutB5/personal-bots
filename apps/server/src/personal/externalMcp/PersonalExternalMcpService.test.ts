import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PersonalBotId, PersonalExternalMcpServerId, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalExternalMcpRepository from "./PersonalExternalMcpRepository.ts";
import {
  PersonalExternalMcpService,
  externalMcpTokenStoreKey,
  make as makeExternalMcpService,
  validateExternalMcpSlug,
  validateExternalMcpUrl,
} from "./PersonalExternalMcpService.ts";

const makeInMemorySecretStore = () => {
  const map = new Map<string, Uint8Array>();
  const service: ServerSecretStore.ServerSecretStore["Service"] = {
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
  };
  return { map, layer: Layer.succeed(ServerSecretStore.ServerSecretStore, service) };
};

const makeTestLayer = (options?: {
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly selfOrigins?: ReadonlySet<string>;
  readonly env?: () => NodeJS.ProcessEnv;
}) => {
  const secretStore = makeInMemorySecretStore();
  const base = Layer.mergeAll(
    SqlitePersistence.layerMemory,
    NodeServices.layer,
    NodeCrypto.layer,
    secretStore.layer,
  );
  const repos = Layer.mergeAll(
    PersonalExternalMcpRepository.layer,
    PersonalBotRepository.layer,
  ).pipe(Layer.provideMerge(base));
  const serviceLayer = Layer.effect(
    PersonalExternalMcpService,
    makeExternalMcpService(options),
  ).pipe(Layer.provideMerge(repos));
  return { secretStore, layer: serviceLayer };
};

const seedBot = (botId: string, team: "personal" | "work") =>
  Effect.gen(function* () {
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const now = yield* DateTime.now;
    yield* bots.createBot({
      botId: PersonalBotId.make(botId),
      name: botId,
      title: botId,
      description: "",
      instructions: "",
      avatarShape: "blob",
      avatarColor: "#3B82F6",
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      team,
      lead: false,
      pinned: false,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
  });

describe("PersonalExternalMcpService validation", () => {
  it("validates slugs and rejects reserved t3-code prefixes", () => {
    expect(validateExternalMcpSlug("executor")).toBe("executor");
    expect(validateExternalMcpSlug("my_mcp-2")).toBe("my_mcp-2");
    expect(validateExternalMcpSlug("Uppercase")).toBeNull();
    expect(validateExternalMcpSlug("-leading-dash")).toBeNull();
    expect(validateExternalMcpSlug("t3-code")).toBeNull();
    expect(validateExternalMcpSlug("t3-code-extra")).toBeNull();
    expect(validateExternalMcpSlug("a".repeat(33))).toBeNull();
  });

  it("validates URLs for https, loopback http, and self-loop protection", () => {
    const selfOrigins = new Set(["http://127.0.0.1:3773", "http://localhost:3773"]);

    expect(validateExternalMcpUrl("https://mcp.example.com/v1", selfOrigins).ok).toBe(true);
    expect(validateExternalMcpUrl("http://127.0.0.1:4400/mcp", selfOrigins).ok).toBe(true);
    expect(validateExternalMcpUrl("http://localhost:4400/mcp", selfOrigins).ok).toBe(true);
    expect(validateExternalMcpUrl("http://[::1]:4400/mcp", selfOrigins).ok).toBe(true);

    expect(validateExternalMcpUrl("file:///etc/passwd", selfOrigins).ok).toBe(false);
    expect(validateExternalMcpUrl("http://example.com/mcp", selfOrigins).ok).toBe(false);
    expect(validateExternalMcpUrl("https://user:pass@mcp.example.com/mcp", selfOrigins).ok).toBe(
      false,
    );
    expect(validateExternalMcpUrl("http://127.0.0.1:3773/mcp", selfOrigins).ok).toBe(false);
    expect(
      validateExternalMcpUrl("http://127.0.0.1:4400/api/personal/external-mcp/abc/mcp", selfOrigins)
        .ok,
    ).toBe(false);
  });

  it("marks external MCP bearer tokens as encrypted secret names", () => {
    const key = externalMcpTokenStoreKey(PersonalExternalMcpServerId.make("srv-1"));
    expect(key).toBe("personal-external-mcp:srv-1");
    expect(ServerSecretStore.isEncryptedSecretName(key)).toBe(true);
  });
});

describe("PersonalExternalMcpService CRUD, scoping, encryption & testConnection", () => {
  it("stores bearer tokens in ServerSecretStore only (never in SQLite) and manages lifecycle", async () => {
    const { secretStore, layer } = makeTestLayer();
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* PersonalExternalMcpService;
        const sql = yield* SqlClient.SqlClient;

        const created = yield* svc.create({
          slug: "executor",
          displayName: "Local Executor",
          url: "http://127.0.0.1:4400/mcp",
          scope: "shared",
          bearerToken: "exec-super-secret-token-12345",
        });

        expect(created.slug).toBe("executor");
        expect(created.hasToken).toBe(true);
        expect(JSON.stringify(created)).not.toContain("exec-super-secret-token-12345");

        // Verify token is stored in ServerSecretStore and NOT in SQLite.
        const storeKey = externalMcpTokenStoreKey(created.serverId);
        expect(new TextDecoder().decode(secretStore.map.get(storeKey))).toBe(
          "exec-super-secret-token-12345",
        );
        const rows = yield* sql`SELECT * FROM personal_external_mcp_servers`;
        expect(JSON.stringify(rows)).not.toContain("exec-super-secret-token-12345");

        // Update without bearerToken keeps existing token.
        const updatedKeep = yield* svc.update({
          serverId: created.serverId,
          displayName: "Local Executor v2",
        });
        expect(updatedKeep.displayName).toBe("Local Executor v2");
        expect(updatedKeep.hasToken).toBe(true);
        expect(new TextDecoder().decode(secretStore.map.get(storeKey))).toBe(
          "exec-super-secret-token-12345",
        );

        // Update with empty bearerToken clears token.
        const updatedClear = yield* svc.update({
          serverId: created.serverId,
          bearerToken: "",
        });
        expect(updatedClear.hasToken).toBe(false);
        expect(secretStore.map.has(storeKey)).toBe(false);

        // Update with new bearerToken replaces token.
        const updatedReplace = yield* svc.update({
          serverId: created.serverId,
          bearerToken: "exec-rotated-token-99999",
        });
        expect(updatedReplace.hasToken).toBe(true);
        expect(new TextDecoder().decode(secretStore.map.get(storeKey))).toBe(
          "exec-rotated-token-99999",
        );

        // Delete removes DB row and stored token.
        yield* svc.delete({ serverId: created.serverId });
        expect(secretStore.map.has(storeKey)).toBe(false);
        const listed = yield* svc.list();
        expect(listed.servers).toEqual([]);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("filters servers by shared, team, and bot scope and honors kill switch", async () => {
    let env: NodeJS.ProcessEnv = {};
    const { layer } = makeTestLayer({ env: () => env });
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedBot("bot-personal", "personal");
        yield* seedBot("bot-work", "work");

        const svc = yield* PersonalExternalMcpService;
        const shared = yield* svc.create({
          slug: "shared-srv",
          displayName: "Shared",
          url: "https://shared.example.com/mcp",
          scope: "shared",
        });
        const workOnly = yield* svc.create({
          slug: "work-srv",
          displayName: "Work",
          url: "https://work.example.com/mcp",
          scope: "team",
          scopeId: "work",
        });
        const botOnly = yield* svc.create({
          slug: "bot-srv",
          displayName: "Bot Only",
          url: "https://bot.example.com/mcp",
          scope: "bot",
          scopeId: "bot-personal",
        });
        yield* svc.create({
          slug: "disabled-srv",
          displayName: "Disabled",
          url: "https://disabled.example.com/mcp",
          scope: "shared",
          enabled: false,
        });

        const personalServers = yield* svc.forBot(PersonalBotId.make("bot-personal"));
        expect(personalServers.map((s) => s.slug)).toEqual(["bot-srv", "shared-srv"]);

        const workServers = yield* svc.forBot(PersonalBotId.make("bot-work"));
        expect(workServers.map((s) => s.slug)).toEqual(["shared-srv", "work-srv"]);

        // resolveForProxy checks visibility.
        expect(
          Option.isSome(
            yield* svc.resolveForProxy(workOnly.serverId, PersonalBotId.make("bot-work")),
          ),
        ).toBe(true);
        expect(
          Option.isNone(
            yield* svc.resolveForProxy(workOnly.serverId, PersonalBotId.make("bot-personal")),
          ),
        ).toBe(true);
        expect(
          Option.isNone(
            yield* svc.resolveForProxy(botOnly.serverId, PersonalBotId.make("bot-work")),
          ),
        ).toBe(true);

        // Kill switch disables both forBot and resolveForProxy.
        env = { T3CODE_PERSONAL_EXTERNAL_MCP: "off" };
        expect(yield* svc.forBot(PersonalBotId.make("bot-personal"))).toEqual([]);
        expect(
          Option.isNone(
            yield* svc.resolveForProxy(shared.serverId, PersonalBotId.make("bot-personal")),
          ),
        ).toBe(true);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("tests connection with MCP initialize, parses JSON/SSE, and scrubs tokens on error", async () => {
    const seenHeaders: Array<Record<string, string>> = [];
    let mode: "json" | "sse" | "error" = "json";
    const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenHeaders.push(headers);
      if (mode === "error") {
        throw new Error("Connection failed with Bearer top-secret-upstream-token");
      }
      if (mode === "sse") {
        return new Response(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { serverInfo: { name: "executor-sse", version: "2.1.0" } },
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { serverInfo: { name: "executor", version: "1.4.0" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const { layer } = makeTestLayer({ fetchImpl: fakeFetch });
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* PersonalExternalMcpService;
        const created = yield* svc.create({
          slug: "executor",
          displayName: "Executor",
          url: "http://127.0.0.1:4400/mcp",
          scope: "shared",
          bearerToken: "top-secret-upstream-token",
        });

        mode = "json";
        const jsonRes = yield* svc.testConnection({ serverId: created.serverId });
        expect(jsonRes).toEqual({
          ok: true,
          statusCode: 200,
          serverName: "executor",
          serverVersion: "1.4.0",
        });
        expect(seenHeaders[0]?.authorization).toBe("Bearer top-secret-upstream-token");

        mode = "sse";
        const sseRes = yield* svc.testConnection({ serverId: created.serverId });
        expect(sseRes).toEqual({
          ok: true,
          statusCode: 200,
          serverName: "executor-sse",
          serverVersion: "2.1.0",
        });

        mode = "error";
        const errRes = yield* svc.testConnection({ serverId: created.serverId });
        expect(errRes.ok).toBe(false);
        expect(errRes.error).toContain("[redacted]");
        expect(errRes.error).not.toContain("top-secret-upstream-token");
      }).pipe(Effect.provide(layer)),
    );
  });
});
