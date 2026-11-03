// @effect-diagnostics nodeBuiltinImport:off - the fixture writes latest.json and the APK exactly as the publish script does.
import * as NodeCrypto from "node:crypto";
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { EnvironmentAuth, ServerAuthMissingCredentialError } from "../../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../../config.ts";
import {
  PERSONAL_ANDROID_APK_ROUTE_PREFIX,
  personalAndroidApkRouteLayer,
} from "./androidApkRoute.ts";

const disposers: Array<() => Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});

const CURRENT = "1.66.120";
const APK_BYTES = Uint8Array.from({ length: 1_200_000 }, (_, index) => (index * 37) % 256);
const APK_SHA256 = NodeCrypto.createHash("sha256").update(APK_BYTES).digest("hex");

const manifestFor = (version: string) =>
  JSON.stringify({
    schema: 1,
    version,
    sha256: APK_SHA256,
    size: APK_BYTES.byteLength,
    notes: "Update screen and zoom fixes",
  });

type AuthFixture = "missing" | "cookie" | ReadonlyArray<AuthEnvironmentScope>;

interface FixtureOptions {
  readonly auth: AuthFixture;
  /** Omit to leave latest.json out of the root. */
  readonly manifest?: string | null;
  /** Also write an APK for this version, and the current one unless `currentApk` is false. */
  readonly extraApkVersion?: string;
  readonly currentApk?: boolean;
}

const fixture = async (options: FixtureOptions) => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hbots-android-apk-"));
  roots.push(home);
  const updatesDir = NodePath.join(home, "android-updates");
  await NodeFSP.mkdir(updatesDir, { recursive: true });
  if (options.manifest !== null) {
    await NodeFSP.writeFile(
      NodePath.join(updatesDir, "latest.json"),
      options.manifest ?? manifestFor(CURRENT),
      "utf8",
    );
  }
  if (options.currentApk !== false) {
    await NodeFSP.writeFile(NodePath.join(updatesDir, `hbots-${CURRENT}.apk`), APK_BYTES);
  }
  if (options.extraApkVersion !== undefined) {
    await NodeFSP.writeFile(
      NodePath.join(updatesDir, `hbots-${options.extraApkVersion}.apk`),
      "old bytes",
    );
  }

  const { handler, dispose } = HttpRouter.toWebHandler(
    personalAndroidApkRouteLayer.pipe(
      Layer.provideMerge(
        Layer.succeed(ServerConfig.ServerConfig, {
          baseDir: home,
        } as unknown as ServerConfig.ServerConfig["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth, {
          authenticateHttpRequest: () =>
            options.auth === "missing"
              ? Effect.fail(new ServerAuthMissingCredentialError({}))
              : Effect.succeed({
                  sessionId: AuthSessionId.make("session-1"),
                  subject: "test",
                  method:
                    options.auth === "cookie" ? "browser-session-cookie" : "bearer-access-token",
                  scopes: options.auth === "cookie" ? [AuthOrchestrationReadScope] : options.auth,
                }),
        } as unknown as EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, home, updatesDir };
};

const TOKEN = { authorization: "Bearer test-token" };

const get = (path: string, headers?: Record<string, string>) =>
  new Request(
    `http://t3.test${path}`,
    headers === undefined ? { method: "GET" } : { method: "GET", headers },
  );

const apk = (version: string) => `${PERSONAL_ANDROID_APK_ROUTE_PREFIX}/${version}`;

describe("the APK the phone downloads for a self-update", () => {
  it("serves the published APK's exact bytes with its ASCII length and Android type", async () => {
    const { handler } = await fixture({ auth: [AuthOrchestrationReadScope] });
    const response = await handler(get(apk(CURRENT), TOKEN));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/vnd.android.package-archive");
    expect(response.headers.get("content-length")).toBe(String(APK_BYTES.byteLength));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(APK_BYTES))).toBe(true);
  });

  it("refuses a request with no Bearer header before it looks at the token", async () => {
    const { handler } = await fixture({ auth: [AuthOrchestrationReadScope] });
    expect((await handler(get(apk(CURRENT)))).status).toBe(401);
  });

  it("refuses a browser cookie session even when the request also carries a Bearer header", async () => {
    const { handler } = await fixture({ auth: "cookie" });
    expect((await handler(get(apk(CURRENT), TOKEN))).status).toBe(401);
  });

  it("refuses an invalid Bearer token", async () => {
    const { handler } = await fixture({ auth: "missing" });
    expect((await handler(get(apk(CURRENT), TOKEN))).status).toBe(401);
  });

  it("refuses a valid Bearer token that lacks read scope", async () => {
    const { handler } = await fixture({ auth: [] });
    expect((await handler(get(apk(CURRENT), TOKEN))).status).toBe(403);
  });

  it("serves only the version named by the manifest, never an older file", async () => {
    const { handler } = await fixture({
      auth: [AuthOrchestrationReadScope],
      extraApkVersion: "1.66.119",
    });
    expect((await handler(get(apk("1.66.119"), TOKEN))).status).toBe(404);
  });

  it("answers 404 when there is no manifest or it is not valid", async () => {
    const missing = await fixture({ auth: [AuthOrchestrationReadScope], manifest: null });
    expect((await missing.handler(get(apk(CURRENT), TOKEN))).status).toBe(404);
    const broken = await fixture({ auth: [AuthOrchestrationReadScope], manifest: "{not json" });
    expect((await broken.handler(get(apk(CURRENT), TOKEN))).status).toBe(404);
  });

  it("answers 404 when the manifest names an APK the server does not have", async () => {
    const { handler } = await fixture({
      auth: [AuthOrchestrationReadScope],
      currentApk: false,
    });
    expect((await handler(get(apk(CURRENT), TOKEN))).status).toBe(404);
  });

  it("answers 404 when the APK path is a symlink to a file outside the updates directory", async () => {
    const { handler, home, updatesDir } = await fixture({
      auth: [AuthOrchestrationReadScope],
      currentApk: false,
    });
    const outside = NodePath.join(home, "outside.bin");
    await NodeFSP.writeFile(outside, APK_BYTES);
    await NodeFSP.symlink(outside, NodePath.join(updatesDir, `hbots-${CURRENT}.apk`));

    expect((await handler(get(apk(CURRENT), TOKEN))).status).toBe(404);
  });

  it("answers 404 when the android-updates folder is a symlink to another folder", async () => {
    const { handler, home, updatesDir } = await fixture({
      auth: [AuthOrchestrationReadScope],
      manifest: null,
      currentApk: false,
    });
    const linkedDir = NodePath.join(home, "linked-updates");
    await NodeFSP.mkdir(linkedDir);
    await NodeFSP.writeFile(NodePath.join(linkedDir, "latest.json"), manifestFor(CURRENT));
    await NodeFSP.writeFile(NodePath.join(linkedDir, `hbots-${CURRENT}.apk`), APK_BYTES);
    await NodeFSP.rm(updatesDir, { recursive: true });
    await NodeFSP.symlink(linkedDir, updatesDir);

    expect((await handler(get(apk(CURRENT), TOKEN))).status).toBe(404);
  });

  it("answers 404 when the APK is not the size the manifest published", async () => {
    const { handler, updatesDir } = await fixture({ auth: [AuthOrchestrationReadScope] });
    await NodeFSP.writeFile(
      NodePath.join(updatesDir, `hbots-${CURRENT}.apk`),
      APK_BYTES.subarray(0, APK_BYTES.byteLength - 1),
    );

    expect((await handler(get(apk(CURRENT), TOKEN))).status).toBe(404);
  });

  it("answers 404 when the APK path is a directory", async () => {
    const { handler, updatesDir } = await fixture({
      auth: [AuthOrchestrationReadScope],
      currentApk: false,
    });
    await NodeFSP.mkdir(NodePath.join(updatesDir, `hbots-${CURRENT}.apk`));

    const response = await handler(get(apk(CURRENT), TOKEN));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });

  it.each(["", "1.66", "1.66.120.1", "v1.66.120", "1.66.120%00", "1.66.120/extra"])(
    "answers 400 for the malformed version %j",
    async (version) => {
      const { handler } = await fixture({ auth: [AuthOrchestrationReadScope] });
      expect((await handler(get(apk(version), TOKEN))).status).toBe(400);
    },
  );

  it.each(["..%2f..%2fetc%2fpasswd", "%2e%2e%2f", "%2e%2e%5c", "..%5c..%5cwindows"])(
    "answers 400 for the traversal version %j",
    async (version) => {
      const { handler } = await fixture({ auth: [AuthOrchestrationReadScope] });
      expect((await handler(get(apk(version), TOKEN))).status).toBe(400);
    },
  );
});
