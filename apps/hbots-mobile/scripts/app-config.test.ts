// @effect-diagnostics nodeBuiltinImport:off - Reads the version file the config derives from.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import config, { versionCodeFor } from "../app.config";
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

  it("builds only the phone's arm64 ABI", () => {
    const buildProperties = config.plugins?.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === "expo-build-properties",
    );
    expect(buildProperties).toEqual([
      "expo-build-properties",
      expect.objectContaining({ android: expect.objectContaining({ buildArchs: ["arm64-v8a"] }) }),
    ]);
    expect(config.plugins).toContain("./plugins/withAndroidReleaseSigning.cjs");
  });

  it("ships the adaptive and monochrome launcher icon", () => {
    const icon = config.android?.adaptiveIcon;
    expect(icon).toEqual({
      foregroundImage: "./assets/icon/foreground.png",
      backgroundImage: "./assets/icon/background.png",
      monochromeImage: "./assets/icon/monochrome.png",
    });
    for (const image of Object.values(icon ?? {})) {
      expect(NodeFS.existsSync(NodePath.resolve(__dirname, "..", image))).toBe(true);
    }
  });

  it("paints the system UI the app's dark background", () => {
    expect(config.backgroundColor).toBe("#0f0f0e");
    expect(config.plugins).toContain("expo-system-ui");
  });

  it("takes its version from the hbots release file", () => {
    const releaseVersion = NodeFS.readFileSync(
      NodePath.join(REPO_ROOT, "scripts/personal/app-version.txt"),
      "utf8",
    ).trim();
    expect(config.version).toBe(releaseVersion);
    expect(packageVersion).toBe(releaseVersion);
    expect(config.android?.versionCode).toBe(versionCodeFor(releaseVersion));
  });

  it("raises versionCode on every release bump", () => {
    expect(versionCodeFor("1.66.111")).toBe(1_066_111);
    expect(versionCodeFor("1.66.111")).toBeGreaterThan(versionCodeFor("1.66.110"));
    expect(versionCodeFor("1.67.0")).toBeGreaterThan(versionCodeFor("1.66.999"));
    expect(versionCodeFor("2.0.0")).toBeGreaterThan(versionCodeFor("1.999.999"));
  });

  it("refuses a version part that would collide with the next one", () => {
    expect(() => versionCodeFor("1.66.1000")).toThrow(/each part 0-999/u);
    expect(() => versionCodeFor("1.66")).toThrow(/each part 0-999/u);
  });

  it("asks Android to drop the template permissions the app never uses", () => {
    expect(config.android?.blockedPermissions).toEqual([
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
    ]);
  });
});
