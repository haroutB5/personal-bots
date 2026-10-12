// @effect-diagnostics nodeBuiltinImport:off - the fixture writes result files exactly as the release runner does.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { EnvironmentAuth, ServerAuthMissingCredentialError } from "../../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../../config.ts";
import {
  PERSONAL_UPDATE_STATUS_PATH,
  makePersonalUpdateStatusRouteLayer,
} from "./updateStatusRoute.ts";

const disposers: Array<() => Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});

interface Fixture {
  readonly handler: (request: Request) => Promise<Response>;
  /** Where the release tools would write restart-<ver>-result.json. */
  readonly dropDir: string;
  readonly baseDir: string;
}

/**
 * A server whose data root sits where the live one does (a "dev" root beside
 * the shared run folder) unless `flatRoot` asks for a throwaway layout.
 */
const fixture = async (options: {
  auth: "missing" | ReadonlyArray<AuthEnvironmentScope>;
  cacheMs?: number;
  flatRoot?: boolean;
  liveVersion?: string | null;
}): Promise<Fixture> => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hbots-update-status-"));
  roots.push(home);
  const baseDir = options.flatRoot === true ? home : NodePath.join(home, "dev");
  const runDir =
    options.flatRoot === true ? NodePath.join(baseDir, "run") : NodePath.join(home, "run");
  await NodeFSP.mkdir(runDir, { recursive: true });
  const staticDir = NodePath.join(home, "static");
  await NodeFSP.mkdir(staticDir, { recursive: true });
  if (options.liveVersion !== null) {
    await NodeFSP.writeFile(
      NodePath.join(staticDir, "version.txt"),
      `version=${options.liveVersion ?? "1.66.33"}\n`,
      "utf8",
    );
  }

  const { handler, dispose } = HttpRouter.toWebHandler(
    makePersonalUpdateStatusRouteLayer({
      ...(options.cacheMs === undefined ? {} : { cacheMs: options.cacheMs }),
    }).pipe(
      Layer.provideMerge(
        Layer.succeed(ServerConfig.ServerConfig, {
          baseDir,
          staticDir: options.liveVersion === null ? undefined : staticDir,
        } as unknown as ServerConfig.ServerConfig["Service"]),
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
  return { handler, dropDir: runDir, baseDir };
};

const get = (path: string) => new Request(`http://t3.test${path}`, { method: "GET" });

/** Exactly what the release runner writes: UTF-8 with BOM. */
const writeResult = async (dir: string, name: string, body: unknown, mtimeMs?: number) => {
  const file = NodePath.join(dir, name);
  await NodeFSP.writeFile(file, `﻿${JSON.stringify(body, null, 2)}`, "utf8");
  if (mtimeMs !== undefined) await NodeFSP.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
};

describe("the update status the phone polls", () => {
  it("answers with the newest run's phase, the target version and the version still live", async () => {
    const { handler, dropDir } = await fixture({ auth: [AuthOrchestrationReadScope] });
    await writeResult(dropDir, "restart-1.66.34-result.json", {
      runner: "hbots-release.ps1",
      mode: "run",
      status: "waiting_for_idle",
      version: "1.66.34",
    });
    const response = await handler(get(PERSONAL_UPDATE_STATUS_PATH));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.phase).toBe("waiting_for_idle");
    expect(body.version).toBe("1.66.34");
    expect(body.previousVersion).toBe("1.66.33");
    const stamp = await NodeFSP.stat(NodePath.join(dropDir, "restart-1.66.34-result.json"));
    expect(Math.abs(Date.parse(String(body.updatedAt)) - stamp.mtimeMs)).toBeLessThan(1_000);
  });

  it("reads the run folder beside a live root, and one inside a throwaway root", async () => {
    for (const flatRoot of [false, true]) {
      const { handler, dropDir } = await fixture({
        auth: [AuthOrchestrationReadScope],
        cacheMs: 0,
        flatRoot,
      });
      await writeResult(dropDir, "restart-1.66.34-result.json", {
        mode: "run",
        status: "backing_up",
        version: "1.66.34",
      });
      const body = (await (await handler(get(PERSONAL_UPDATE_STATUS_PATH))).json()) as {
        phase: unknown;
      };
      expect(body.phase).toBe("backing_up");
    }
  });

  it("shows the newest run only, and ignores dry runs, waits and superseded waits", async () => {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
    const { handler, dropDir } = await fixture({ auth: [AuthOrchestrationReadScope], cacheMs: 0 });
    await writeResult(
      dropDir,
      "restart-1.66.33-result.json",
      { mode: "run", status: "live_verified", version: "1.66.33" },
      now - 3 * 24 * 60 * 60_000,
    );
    await writeResult(
      dropDir,
      "restart-1.66.34-dryrun-result.json",
      { mode: "dryrun", status: "dryrun_ok", version: "1.66.34" },
      now,
    );
    const idle = (await (await handler(get(PERSONAL_UPDATE_STATUS_PATH))).json()) as {
      phase: unknown;
    };
    // The dry run is the newest file, but it is not a run: nothing shows.
    expect(idle.phase).toBeNull();

    await writeResult(
      dropDir,
      "restart-1.66.35-result.json",
      { mode: "run", status: "superseded_before_activation", version: "1.66.35" },
      now + 1,
    );
    const superseded = (await (await handler(get(PERSONAL_UPDATE_STATUS_PATH))).json()) as {
      phase: unknown;
    };
    expect(superseded.phase).toBeNull();

    await writeResult(
      dropDir,
      "restart-1.66.36-result.json",
      { mode: "run", status: "activating", version: "1.66.36" },
      now + 2,
    );
    const active = (await (await handler(get(PERSONAL_UPDATE_STATUS_PATH))).json()) as {
      phase: unknown;
      version: unknown;
    };
    expect(active.phase).toBe("activating");
    expect(active.version).toBe("1.66.36");
  });

  it("answers from the cache without touching the disk again", async () => {
    const { handler, dropDir } = await fixture({
      auth: [AuthOrchestrationReadScope],
      cacheMs: 60_000,
    });
    await writeResult(dropDir, "restart-1.66.34-result.json", {
      mode: "run",
      status: "smoking",
      version: "1.66.34",
    });
    const first = (await (await handler(get(PERSONAL_UPDATE_STATUS_PATH))).json()) as {
      phase: unknown;
    };
    expect(first.phase).toBe("smoking");
    // The runner moves on and the page would be wrong without the refresh
    // window, but inside it the answer is served without another read - even
    // when the file it came from is gone.
    await NodeFSP.rm(NodePath.join(dropDir, "restart-1.66.34-result.json"));
    const cached = (await (await handler(get(PERSONAL_UPDATE_STATUS_PATH))).json()) as {
      phase: unknown;
    };
    expect(cached.phase).toBe("smoking");
  });

  it("says nothing when the run folder is empty or missing, and nothing for a foreign status", async () => {
    const { handler, dropDir } = await fixture({ auth: [AuthOrchestrationReadScope], cacheMs: 0 });
    const empty = (await (await handler(get(PERSONAL_UPDATE_STATUS_PATH))).json()) as {
      phase: unknown;
      version: unknown;
      previousVersion: unknown;
      updatedAt: unknown;
    };
    expect(empty).toEqual({
      phase: null,
      version: null,
      previousVersion: null,
      updatedAt: null,
    });
    await writeResult(dropDir, "restart-1.66.34-result.json", {
      mode: "run",
      status: "some-future-status",
      version: "1.66.34",
    });
    const foreign = (await (await handler(get(PERSONAL_UPDATE_STATUS_PATH))).json()) as {
      phase: unknown;
    };
    expect(foreign.phase).toBeNull();
  });

  it("refuses callers before reading anything", async () => {
    const anonymous = await fixture({ auth: "missing" });
    expect((await anonymous.handler(get(PERSONAL_UPDATE_STATUS_PATH))).status).toBe(401);
    const noScope = await fixture({ auth: [] });
    expect((await noScope.handler(get(PERSONAL_UPDATE_STATUS_PATH))).status).toBe(403);
  });
});
