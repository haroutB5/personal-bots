// @effect-diagnostics nodeBuiltinImport:off - Reads the version file the config derives from.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import config from "../app.config";
import { version as packageVersion } from "../package.json";

const REPO_ROOT = NodePath.resolve(__dirname, "../../..");

describe("app.config", () => {
  it("identifies the app as hbots under the haroutB5 package id", () => {
    expect(config.name).toBe("hbots");
    expect(config.scheme).toBe("hbots");
    expect(config.android?.package).toBe("com.haroutb5.hbots");
  });

  it("ships no update channel", () => {
    expect(config.updates).toEqual({ enabled: false });
    expect(config.extra).toBeUndefined();
    expect(config.owner).toBeUndefined();
  });

  it("keeps backups and cleartext traffic off", () => {
    expect(config.android?.allowBackup).toBe(false);
    const buildProperties = config.plugins?.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === "expo-build-properties",
    );
    expect(buildProperties).toEqual([
      "expo-build-properties",
      expect.objectContaining({
        android: expect.objectContaining({ usesCleartextTraffic: false }),
      }),
    ]);
  });

  it("takes its version from the hbots release file", () => {
    const releaseVersion = NodeFS.readFileSync(
      NodePath.join(REPO_ROOT, "scripts/personal/app-version.txt"),
      "utf8",
    ).trim();
    expect(config.version).toBe(releaseVersion);
    expect(packageVersion).toBe(releaseVersion);
    expect(config.android?.versionCode).toBe(1_066_110);
  });
});
