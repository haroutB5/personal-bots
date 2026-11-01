// @effect-diagnostics nodeBuiltinImport:off - the fixture writes version.txt exactly as a build does.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../../config.ts";
import {
  PERSONAL_CLIENT_COMPAT_PATH,
  personalClientCompatRouteLayer,
} from "./clientCompatRoute.ts";

const disposers: Array<() => Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});

/** A server root; `stamp` is the version.txt body, or null for a dev root without a static dir. */
const fixture = async (stamp: string | null) => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hbots-client-compat-"));
  roots.push(home);
  let staticDir: string | undefined;
  if (stamp !== null) {
    staticDir = NodePath.join(home, "static");
    await NodeFSP.mkdir(staticDir, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(staticDir, "version.txt"), stamp, "utf8");
  }

  const { handler, dispose } = HttpRouter.toWebHandler(
    personalClientCompatRouteLayer.pipe(
      Layer.provideMerge(
        Layer.succeed(ServerConfig.ServerConfig, {
          baseDir: home,
          staticDir,
        } as unknown as ServerConfig.ServerConfig["Service"]),
      ),
      Layer.provideMerge(Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return handler;
};

const get = () => new Request(`http://t3.test${PERSONAL_CLIENT_COMPAT_PATH}`, { method: "GET" });

describe("the version handshake the phone reads before signing in", () => {
  it("answers with the running release version and the oldest Android build, without auth", async () => {
    const handler = await fixture("version=1.66.110\n");
    const response = await handler(get());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      serverVersion: "1.66.110",
      android: { minimumNativeVersion: "1.66.110" },
    });
  });

  it("reports an unknown server version for a dev root with no stamp", async () => {
    const handler = await fixture(null);
    expect(await (await handler(get())).json()).toEqual({
      serverVersion: null,
      android: { minimumNativeVersion: "1.66.110" },
    });
  });

  it("treats a malformed stamp as unknown instead of failing the handshake", async () => {
    const handler = await fixture("version=not-a-release\n");
    const response = await handler(get());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      serverVersion: null,
      android: { minimumNativeVersion: "1.66.110" },
    });
  });
});
