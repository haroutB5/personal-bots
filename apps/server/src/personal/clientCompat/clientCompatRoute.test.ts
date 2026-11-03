// @effect-diagnostics nodeBuiltinImport:off - the fixture writes version.txt and latest.json exactly as the build does.
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

const MANIFEST_MAX_BYTES = 64 * 1024;

const RELEASE = {
  schema: 1,
  version: "1.66.120",
  sha256: "0123456789abcdef".repeat(4),
  size: 46_076_721,
  notes: "Update screen and zoom fixes",
} as const;

/**
 * A server root; `stamp` is the version.txt body, or null for a dev root
 * without a static dir. `manifest` is the exact latest.json body; undefined
 * means the file does not exist.
 */
const fixture = async (options: { stamp: string | null; manifest?: string }) => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hbots-client-compat-"));
  roots.push(home);
  let staticDir: string | undefined;
  if (options.stamp !== null) {
    staticDir = NodePath.join(home, "static");
    await NodeFSP.mkdir(staticDir, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(staticDir, "version.txt"), options.stamp, "utf8");
  }
  if (options.manifest !== undefined) {
    const updatesDir = NodePath.join(home, "android-updates");
    await NodeFSP.mkdir(updatesDir, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(updatesDir, "latest.json"), options.manifest, "utf8");
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

const NO_RELEASE = { minimumNativeVersion: "1.66.110", latest: null };

describe("the version handshake the phone reads before signing in", () => {
  it("answers with the running release version and the oldest Android build, without auth", async () => {
    const handler = await fixture({ stamp: "version=1.66.110\n" });
    const response = await handler(get());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      serverVersion: "1.66.110",
      android: NO_RELEASE,
    });
  });

  it("publishes the latest APK from latest.json, without the manifest's schema field", async () => {
    const handler = await fixture({
      stamp: "version=1.66.112\n",
      manifest: JSON.stringify(RELEASE),
    });

    expect(await (await handler(get())).json()).toEqual({
      serverVersion: "1.66.112",
      android: {
        minimumNativeVersion: "1.66.110",
        latest: {
          version: "1.66.120",
          sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          size: 46_076_721,
          notes: "Update screen and zoom fixes",
        },
      },
    });
  });

  it("reports an unknown server version for a dev root with no stamp", async () => {
    const handler = await fixture({ stamp: null });
    expect(await (await handler(get())).json()).toEqual({
      serverVersion: null,
      android: NO_RELEASE,
    });
  });

  it("treats a malformed stamp as unknown instead of failing the handshake", async () => {
    const handler = await fixture({ stamp: "version=not-a-release\n" });
    const response = await handler(get());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      serverVersion: null,
      android: NO_RELEASE,
    });
  });

  it("says there is no release when latest.json is missing", async () => {
    const handler = await fixture({ stamp: "version=1.66.112\n" });
    expect(await (await handler(get())).json()).toEqual({
      serverVersion: "1.66.112",
      android: NO_RELEASE,
    });
  });

  it("says there is no release when latest.json is not JSON", async () => {
    const handler = await fixture({ stamp: "version=1.66.112\n", manifest: "{not json" });
    const response = await handler(get());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      serverVersion: "1.66.112",
      android: NO_RELEASE,
    });
  });

  it("says there is no release when the manifest schema is not 1", async () => {
    const handler = await fixture({
      stamp: "version=1.66.112\n",
      manifest: JSON.stringify({ ...RELEASE, schema: 2 }),
    });
    expect(await (await handler(get())).json()).toEqual({
      serverVersion: "1.66.112",
      android: NO_RELEASE,
    });
  });

  it("says there is no release when latest.json is larger than the manifest cap", async () => {
    const oversized = `${JSON.stringify(RELEASE)}${" ".repeat(MANIFEST_MAX_BYTES)}`;
    const handler = await fixture({ stamp: "version=1.66.112\n", manifest: oversized });

    expect(oversized.length).toBeGreaterThan(MANIFEST_MAX_BYTES);
    expect(await (await handler(get())).json()).toEqual({
      serverVersion: "1.66.112",
      android: NO_RELEASE,
    });
  });

  it.each([
    ["sha256 is not 64 lowercase hex", { ...RELEASE, sha256: "ABC" }],
    ["size is below the published range", { ...RELEASE, size: 999 }],
    ["notes are longer than 500 characters", { ...RELEASE, notes: "x".repeat(501) }],
    ["version is not a release version", { ...RELEASE, version: "1.66" }],
  ])("says there is no release when %s", async (_name, manifest) => {
    const handler = await fixture({
      stamp: "version=1.66.112\n",
      manifest: JSON.stringify(manifest),
    });
    expect(await (await handler(get())).json()).toEqual({
      serverVersion: "1.66.112",
      android: NO_RELEASE,
    });
  });
});
