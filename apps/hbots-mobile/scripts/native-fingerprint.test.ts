// @effect-diagnostics nodeBuiltinImport:off - Builds a throwaway app tree on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { applyVersion, nativeFingerprint } from "./nativeFingerprint.ts";

const roots: string[] = [];

function tree() {
  const repoRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-fingerprint-"));
  roots.push(repoRoot);
  const appDir = NodePath.join(repoRoot, "apps/hbots-mobile");
  const write = (rel: string, text: string) => {
    const path = NodePath.join(repoRoot, rel);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, text);
  };
  write("apps/hbots-mobile/app.config.ts", "export default {};\n");
  write("apps/hbots-mobile/plugins/withThing.cjs", "module.exports = (c) => c;\n");
  write("apps/hbots-mobile/assets/icon.png", "png");
  write("apps/hbots-mobile/src/App.tsx", "export const App = 1;\n");
  write("apps/hbots-mobile/modules/hbots-x/expo-module.config.json", "{}\n");
  write("apps/hbots-mobile/modules/hbots-x/android/src/main/java/X.kt", "class X\n");
  write("apps/hbots-mobile/modules/hbots-x/android/src/test/java/XTest.kt", "class XTest\n");
  write("apps/hbots-mobile/modules/hbots-x/android/build/out.txt", "built\n");
  write("apps/hbots-mobile/modules/hbots-x/src/index.ts", "export {};\n");
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write("scripts/personal/app-version.txt", "1.67.51\n");
  const fingerprint = (env: Record<string, string | undefined> = {}) =>
    nativeFingerprint({ appDir, repoRoot, env });
  return { repoRoot, appDir, write, fingerprint };
}

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("nativeFingerprint", () => {
  it("is stable, and ignores JS, the version, build outputs and JVM tests", () => {
    const t = tree();
    const before = t.fingerprint();
    expect(t.fingerprint()).toBe(before);
    t.write("apps/hbots-mobile/src/App.tsx", "export const App = 2;\n");
    t.write("apps/hbots-mobile/modules/hbots-x/src/index.ts", "export const y = 1;\n");
    t.write("scripts/personal/app-version.txt", "1.67.52\n");
    t.write("apps/hbots-mobile/modules/hbots-x/android/build/out.txt", "rebuilt\n");
    t.write("apps/hbots-mobile/modules/hbots-x/android/src/test/java/XTest.kt", "class XTest2\n");
    expect(t.fingerprint()).toBe(before);
  });

  it("ignores the app package.json version bump but not its dependencies", () => {
    const t = tree();
    t.write(
      "apps/hbots-mobile/package.json",
      '{"name":"@hbots/mobile","version":"1.67.52","dependencies":{"expo":"1.0.0"}}\n',
    );
    const before = t.fingerprint();
    t.write(
      "apps/hbots-mobile/package.json",
      '{"name":"@hbots/mobile","version":"1.67.53","dependencies":{"expo":"1.0.0"}}\n',
    );
    expect(t.fingerprint()).toBe(before);
    t.write(
      "apps/hbots-mobile/package.json",
      '{"name":"@hbots/mobile","version":"1.67.53","dependencies":{"expo":"1.0.1"}}\n',
    );
    expect(t.fingerprint()).not.toBe(before);
  });

  it.each([
    ["the app config", "apps/hbots-mobile/app.config.ts"],
    ["a config plugin", "apps/hbots-mobile/plugins/withThing.cjs"],
    ["a new plugin", "apps/hbots-mobile/plugins/withOther.cjs"],
    ["an asset", "apps/hbots-mobile/assets/icon.png"],
    ["native module source", "apps/hbots-mobile/modules/hbots-x/android/src/main/java/X.kt"],
    ["a module's Expo config", "apps/hbots-mobile/modules/hbots-x/expo-module.config.json"],
    ["the lockfile", "pnpm-lock.yaml"],
    ["a patch", "patches/react-native.patch"],
  ])("changes with %s", (_label, rel) => {
    const t = tree();
    const before = t.fingerprint();
    t.write(rel, "changed\n");
    expect(t.fingerprint()).not.toBe(before);
  });

  it("changes with the QA arch switch and the Firebase file's content", () => {
    const t = tree();
    const firebase = NodePath.join(t.repoRoot, "google-services.json");
    NodeFS.writeFileSync(firebase, "{}");
    const base = t.fingerprint();
    expect(t.fingerprint({ HBOTS_QA_X86: "1" })).not.toBe(base);
    const withFirebase = t.fingerprint({ HBOTS_GOOGLE_SERVICES_JSON: firebase });
    expect(withFirebase).not.toBe(base);
    NodeFS.writeFileSync(firebase, '{"project_info":{}}');
    expect(t.fingerprint({ HBOTS_GOOGLE_SERVICES_JSON: firebase })).not.toBe(withFirebase);
  });
});

describe("applyVersion", () => {
  const gradle = `android {
    defaultConfig {
        applicationId 'com.haroutb5.hbots'
        versionCode 1067049
        versionName "1.67.49"
    }
}
`;

  it("sets versionCode and versionName from app-version.txt", () => {
    const out = applyVersion(gradle, "1.67.51\n");
    expect(out).toContain("        versionCode 1067051\n");
    expect(out).toContain('        versionName "1.67.51"\n');
    expect(out.replace(/1067051/, "1067049").replace(/"1\.67\.51"/, '"1.67.49"')).toBe(gradle);
  });

  it("refuses a build.gradle it does not recognise, so the build regenerates instead", () => {
    expect(() => applyVersion(gradle.replace(/ *versionName.*\n/, ""), "1.67.51")).toThrow(
      /versionName/,
    );
    expect(() => applyVersion(gradle + "versionCode 2\n", "1.67.51")).toThrow(/2 versionCode/);
  });
});
