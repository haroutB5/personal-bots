import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  AuthPhoneClientScopes,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter } from "effect/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { makeDpopKey } from "../../auth/dpop.testkit.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import {
  CAN_REBOOT_ARGV,
  PERSONAL_SYSTEM_REBOOT_PATH,
  REBOOT_ARGV,
  REBOOT_DELAY_MS,
  REBOOT_RATE_LIMIT_MS,
  makePersonalSystemRebootRouteLayer,
  parseCanReboot,
  type RebootCommandResult,
} from "./rebootRoute.ts";

const URL_BASE = "http://t3.test";
const REBOOT_URL = `${URL_BASE}${PERSONAL_SYSTEM_REBOOT_PATH}`;

const layerSessionStoreWithSql = SessionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-reboot-route-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

interface FixtureOptions {
  readonly canReboot?: RebootCommandResult;
  readonly dryRun?: boolean;
}

const fixture = async (options: FixtureOptions = {}) => {
  const runtime = ManagedRuntime.make(layerSessionStoreWithSql);
  disposers.push(() => runtime.dispose());
  const sessions = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* SessionStore.SessionStore;
    }),
  );
  const sql = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* SqlClient.SqlClient;
    }),
  );
  const run = (statement: Effect.Effect<unknown, unknown>) =>
    runtime.runPromise(Effect.asVoid(statement));
  const database = {
    /** Every write fails, the way a read-only disk fails SQLite; reads still work. */
    readOnly: () => run(sql`PRAGMA query_only = ON`),
    /** Reads of the sessions table fail too, the way a broken database does. */
    failReads: () => run(sql`ALTER TABLE auth_sessions RENAME TO auth_sessions_offline`),
  };

  const commands: Array<ReadonlyArray<string>> = [];
  const logs: string[] = [];
  const scheduled: Array<{ task: () => void; delayMs: number }> = [];
  let nowMs = Date.now();
  let dryRun = options.dryRun ?? false;

  const routeLayer = makePersonalSystemRebootRouteLayer({
    run: async (argv) => {
      commands.push(argv);
      if (argv === CAN_REBOOT_ARGV) {
        return options.canReboot ?? { exitCode: 0, stdout: 's "yes"\n', stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    dryRun: () => dryRun,
    nowMs: () => nowMs,
    schedule: (task, delayMs) => scheduled.push({ task, delayMs }),
    log: (line) => logs.push(line),
  });
  const { handler, dispose } = HttpRouter.toWebHandler(
    routeLayer.pipe(
      Layer.provideMerge(Layer.succeed(SessionStore.SessionStore, sessions)),
      Layer.provideMerge(Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);

  const issue = (input: Parameters<SessionStore.SessionStore["Service"]["issue"]>[0]) =>
    runtime.runPromise(sessions.issue(input));
  const ownerBearer = () =>
    issue({
      subject: "owner-phone",
      method: "bearer-access-token",
      scopes: AuthPhoneClientScopes,
      ttl: Duration.hours(1),
      client: { label: "Pixel", deviceType: "mobile" },
    });

  const call = async (method: "GET" | "POST", headers: Record<string, string> = {}) => {
    const response = await handler(
      new Request(REBOOT_URL, { method, headers: { host: "t3.test", ...headers } }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  return {
    handler,
    call,
    issue,
    ownerBearer,
    database,
    commands,
    logs,
    scheduled,
    rebootCalls: () => commands.filter((argv) => argv === REBOOT_ARGV),
    revoke: (sessionId: SessionStore.VerifiedSession["sessionId"]) =>
      runtime.runPromise(sessions.revoke(sessionId)),
    advance: (ms: number) => {
      nowMs += ms;
    },
    nowMs: () => nowMs,
    setDryRun: (next: boolean) => {
      dryRun = next;
    },
  };
};

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("parseCanReboot", () => {
  it("reads busctl's string reply", () => {
    expect(parseCanReboot('s "yes"\n')).toBe("yes");
    expect(parseCanReboot('s "challenge"')).toBe("challenge");
    expect(parseCanReboot("garbage")).toBeNull();
  });
});

describe("POST /api/personal/system/reboot", () => {
  it("replies first, then asks logind to reboot with the fixed argv", async () => {
    const f = await fixture();
    const owner = await f.ownerBearer();
    const response = await f.call("POST", bearer(owner.token));
    expect(response).toEqual({
      status: 202,
      body: { ok: true, dryRun: false, rebootInMs: REBOOT_DELAY_MS },
    });
    // The preflight ran before the reply; the reboot waits for the timer.
    expect(f.commands).toEqual([CAN_REBOOT_ARGV]);
    expect(f.scheduled.map((entry) => entry.delayMs)).toEqual([REBOOT_DELAY_MS]);
    f.scheduled[0]!.task();
    await Promise.resolve();
    expect(f.rebootCalls()).toHaveLength(1);
    expect(REBOOT_ARGV).toEqual([
      "busctl",
      "--system",
      "call",
      "org.freedesktop.login1",
      "/org/freedesktop/login1",
      "org.freedesktop.login1.Manager",
      "Reboot",
      "b",
      "false",
    ]);
  });

  it("dry run logs 'would reboot' and never calls Reboot", async () => {
    const f = await fixture({ dryRun: true });
    const owner = await f.ownerBearer();
    const response = await f.call("POST", bearer(owner.token));
    expect(response.status).toBe(202);
    expect(response.body.dryRun).toBe(true);
    f.scheduled[0]!.task();
    expect(f.rebootCalls()).toEqual([]);
    expect(f.logs.some((line) => line.startsWith("would reboot"))).toBe(true);
  });

  it("returns logind's refusal text and does not reboot", async () => {
    const challenge = await fixture({
      canReboot: { exitCode: 0, stdout: 's "challenge"\n', stderr: "" },
    });
    const owner = await challenge.ownerBearer();
    const refused = await challenge.call("POST", bearer(owner.token));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('CanReboot is "challenge"');
    expect(challenge.scheduled).toEqual([]);

    const failing = await fixture({
      canReboot: {
        exitCode: 1,
        stdout: "",
        stderr: "Call failed: Access denied\n",
      },
    });
    const owner2 = await failing.ownerBearer();
    const denied = await failing.call("POST", bearer(owner2.token));
    expect(denied).toEqual({
      status: 409,
      body: { ok: false, error: "logind refused: Call failed: Access denied" },
    });
    // The status read shows the same text.
    const status = await failing.call("GET", bearer(owner2.token));
    expect(status.body.error).toBe("logind refused: Call failed: Access denied");
    expect(status.body.lastError).toBe("logind refused: Call failed: Access denied");
  });

  it("allows one restart a minute", async () => {
    const f = await fixture({ dryRun: true });
    const owner = await f.ownerBearer();
    expect((await f.call("POST", bearer(owner.token))).status).toBe(202);
    const again = await f.call("POST", bearer(owner.token));
    expect(again.status).toBe(429);
    expect(again.body.error).toContain("already asked for");
    f.advance(REBOOT_RATE_LIMIT_MS);
    expect((await f.call("POST", bearer(owner.token))).status).toBe(202);
  });

  it("still works when every database write fails (read-only disk)", async () => {
    const f = await fixture();
    const owner = await f.ownerBearer();
    await f.database.readOnly();
    const response = await f.call("POST", bearer(owner.token));
    expect(response.status).toBe(202);
    f.scheduled[0]!.task();
    await Promise.resolve();
    expect(f.rebootCalls()).toHaveLength(1);
  });

  it("still works when the database cannot even be read, for a credential seen before", async () => {
    const f = await fixture();
    const owner = await f.ownerBearer();
    // Settings opening on the phone: the GET that warms the in-memory credential.
    expect((await f.call("GET", bearer(owner.token))).body.canReboot).toBe(true);
    await f.database.failReads();
    const response = await f.call("POST", bearer(owner.token));
    expect(response.status).toBe(202);
    expect(f.logs.some((line) => line.includes("remembered owner credential"))).toBe(true);
  });

  it("refuses an unknown credential when the database cannot be read", async () => {
    const f = await fixture();
    const owner = await f.ownerBearer();
    await f.database.failReads();
    const response = await f.call("POST", bearer(owner.token));
    expect(response.status).toBe(503);
    expect(f.commands).toEqual([]);
  });

  it("refuses a missing credential, a cookie, and a revoked session", async () => {
    const f = await fixture();
    expect((await f.call("POST")).status).toBe(401);
    const owner = await f.ownerBearer();
    expect((await f.call("POST", { cookie: `t3_session=${owner.token}` })).status).toBe(401);
    await f.revoke(owner.sessionId);
    expect((await f.call("POST", bearer(owner.token))).status).toBe(401);
    expect(f.commands).toEqual([]);
  });

  it("refuses a session without the owner scope", async () => {
    const f = await fixture();
    const reader = await f.issue({
      subject: "reader",
      method: "bearer-access-token",
      scopes: [AuthOrchestrationReadScope],
      ttl: Duration.hours(1),
    });
    const response = await f.call("POST", bearer(reader.token));
    expect(response.status).toBe(403);
    expect(f.commands).toEqual([]);
  });

  it("refuses bots: MCP client sessions and MCP registry tokens", async () => {
    const f = await fixture();
    // A signed MCP client session, even one carrying the owner scope.
    const mcpClient = await f.issue({
      subject: "mcp-client",
      method: "bearer-access-token",
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      ttl: Duration.hours(1),
      client: { label: "Claude", deviceType: "bot" },
    });
    const mcp = await f.call("POST", bearer(mcpClient.token));
    expect(mcp).toEqual({
      status: 401,
      body: { ok: false, error: "Bots cannot restart the laptop." },
    });
    // A bot's T3_MCP_TOKEN: random bytes from the MCP session registry, not a session token.
    const botToken = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString(
      "base64url",
    );
    expect((await f.call("POST", bearer(botToken))).status).toBe(401);
    expect(f.commands).toEqual([]);
  });

  it("checks a DPoP-bound session's proof in memory, refusing replays", async () => {
    const f = await fixture({ dryRun: true });
    const key = makeDpopKey();
    const owner = await f.issue({
      subject: "owner-phone",
      method: "dpop-access-token",
      scopes: AuthPhoneClientScopes,
      proofKeyThumbprint: key.thumbprint,
      ttl: Duration.hours(1),
    });
    const proofFor = (method: string) =>
      key.sign({ method, url: REBOOT_URL, token: owner.token, iat: Math.floor(f.nowMs() / 1000) });
    const dpop = (proof: string) => ({ authorization: `DPoP ${owner.token}`, dpop: proof });

    // Without a proof, and as a plain Bearer, it is refused.
    expect((await f.call("POST", { authorization: `DPoP ${owner.token}` })).status).toBe(401);
    expect((await f.call("POST", bearer(owner.token))).status).toBe(401);

    const warm = proofFor("GET");
    const first = await f.call("GET", dpop(warm));
    expect(first.body.error ?? null).toBeNull();
    expect(first.status).toBe(200);
    expect((await f.call("GET", dpop(warm))).body.error).toBe("DPoP proof replayed.");

    await f.database.failReads();
    const response = await f.call("POST", dpop(proofFor("POST")));
    expect(response.status).toBe(202);
  });
});
