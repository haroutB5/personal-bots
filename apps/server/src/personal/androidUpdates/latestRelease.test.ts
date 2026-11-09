// @effect-diagnostics nodeBuiltinImport:off - the fixture plants the links a local writer could.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { readLatestAndroidRelease, resolveAndroidUpdateFile } from "./latestRelease.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});

const CURRENT = "1.66.120";
const MANIFEST = JSON.stringify({
  schema: 1,
  version: CURRENT,
  sha256: "0123456789abcdef".repeat(4),
  size: 46_076_721,
  notes: "Update screen and zoom fixes",
});

const makeRoot = async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hbots-latest-release-"));
  roots.push(home);
  const updatesDir = NodePath.join(home, "android-updates");
  await NodeFSP.mkdir(updatesDir, { recursive: true });
  return { home, updatesDir };
};

const readRelease = (home: string) =>
  Effect.runPromise(readLatestAndroidRelease(home).pipe(Effect.provide(NodeServices.layer)));

const resolveFile = (home: string, fileName: string) =>
  Effect.runPromise(
    resolveAndroidUpdateFile(home, fileName).pipe(Effect.provide(NodeServices.layer)),
  );

describe("the release manifest the server reads", () => {
  it("returns null for a latest.json that is a symlink to a valid manifest", async () => {
    const { home, updatesDir } = await makeRoot();
    await NodeFSP.writeFile(NodePath.join(updatesDir, "decoy.json"), MANIFEST, "utf8");
    await NodeFSP.symlink("decoy.json", NodePath.join(updatesDir, "latest.json"));

    expect(await readRelease(home)).toBeNull();
  });

  it("logs one warning when it refuses a symlinked latest.json", async () => {
    const { home, updatesDir } = await makeRoot();
    const logs: Array<string> = [];
    await NodeFSP.writeFile(NodePath.join(updatesDir, "decoy.json"), MANIFEST, "utf8");
    await NodeFSP.symlink("decoy.json", NodePath.join(updatesDir, "latest.json"));

    const release = await Effect.runPromise(
      readLatestAndroidRelease(home).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Logger.layer([
              Logger.make((options) => {
                logs.push(`${String(options.message)} ${JSON.stringify(options.message)}`);
              }),
            ]),
          ),
        ),
      ),
    );

    expect(release).toBeNull();
    expect(logs.filter((line) => line.includes("android update file refused"))).toHaveLength(1);
    expect(logs.join(" ")).toContain("latest.json");
  });
});

describe("the APK path the route is allowed to read", () => {
  it("returns null for an APK reached through a symlinked android-updates folder", async () => {
    const { home, updatesDir } = await makeRoot();
    const linkedDir = NodePath.join(home, "linked-updates");
    await NodeFSP.mkdir(linkedDir);
    await NodeFSP.writeFile(NodePath.join(linkedDir, `hbots-${CURRENT}.apk`), "apk bytes");
    await NodeFSP.rm(updatesDir, { recursive: true });
    await NodeFSP.symlink(linkedDir, updatesDir);

    expect(await resolveFile(home, `hbots-${CURRENT}.apk`)).toBeNull();
  });

  it("returns the canonical path for a regular APK", async () => {
    const { home, updatesDir } = await makeRoot();
    await NodeFSP.writeFile(NodePath.join(updatesDir, `hbots-${CURRENT}.apk`), "apk bytes");

    const resolved = await resolveFile(home, `hbots-${CURRENT}.apk`);
    expect(resolved).toBe(
      await NodeFSP.realpath(NodePath.join(updatesDir, `hbots-${CURRENT}.apk`)),
    );
  });
});
