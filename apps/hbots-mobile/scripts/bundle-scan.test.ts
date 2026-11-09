// @effect-diagnostics nodeBuiltinImport:off - Bundles the app with Metro and scans the output.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { duplicatePackages } from "./bundleDuplicates";
import { ALLOWED_STRINGS, BUNDLE_RULES, scanBundle } from "./bundleScan";

const PACKAGE_ROOT = NodePath.resolve(__dirname, "..");

const PLANTED: ReadonlyArray<readonly [ruleId: string, text: string]> = [
  ["upstream-package-id", 'applicationId "com.t3tools.t3code"'],
  ["upstream-deep-link", 'Linking.openURL("t3code://pair")'],
  ["expo-updates-url", 'url: "https://u.expo.dev/abc"'],
  ["axiom-tracing", 'fetch("https://api.axiom.co/v1/traces")'],
  ["axiom-tracing", '{ "X-Axiom-Dataset": ds, token: "xaat-abc" } // api.axiom.co'],
  ["eas-owner", 'owner: "pingdotgg"'],
  ["upstream-host", 'fetch("https://relay.t3.codes/register")'],
  ["upstream-host", "See https://t3.codes/terms"],
  ["upstream-relay-push", "await getDevicePushTokenAsync()"],
  ["clerk-sign-in", 'require("@clerk/expo")'],
];

const ALLOWED_BUNDLE_TEXT = [
  '"X-Axiom-Dataset": config.tracesDataset',
  'var T3_PROJECT_FILE_SCHEMA_URL = "https://t3.codes/schema/t3.json";',
  'description: "Checked-in project configuration for T3 Code (t3.json). See https://t3.codes for documentation."',
  "const link = `t3code://pair?${new URLSearchParams([[n, e]])}`;",
  'const help = "https://github.com/pingdotgg/t3code/blob/main/docs/user/t3-connect-troubleshooting.md#x";',
  'const hosted = "https://app.t3.codes";',
].join("\n");

describe("bundle scan rules", () => {
  it.each(PLANTED)("%s fails on %s", (ruleId, text) => {
    expect(scanBundle(`ok\n${text}\nok`).map((finding) => finding.ruleId)).toContain(ruleId);
  });

  it("passes with only the five allowed strings", () => {
    expect(ALLOWED_STRINGS).toHaveLength(5);
    expect(scanBundle(ALLOWED_BUNDLE_TEXT)).toEqual([]);
  });

  it("fails when a forbidden string rides next to an allowed one", () => {
    const text = `${ALLOWED_BUNDLE_TEXT}\nconst dataset = "axiom-prod"`;
    expect(scanBundle(text).map((finding) => finding.ruleId)).toEqual(["axiom-tracing"]);
  });

  it("has a planted case for every rule", () => {
    const covered = new Set(PLANTED.map(([ruleId]) => ruleId));
    expect(BUNDLE_RULES.map((rule) => rule.id).filter((id) => !covered.has(id))).toEqual([]);
  });
});

describe("the bundled app", () => {
  let workDir = "";
  let bundle = "";
  let sources: Array<string> = [];

  // oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- bundles the app once for the scan
  beforeAll(() => {
    const scratch = NodePath.join(PACKAGE_ROOT, ".tmp");
    NodeFS.mkdirSync(scratch, { recursive: true });
    workDir = NodeFS.mkdtempSync(NodePath.join(scratch, "bundle-"));
    const output = NodePath.join(workDir, "index.android.bundle");
    const sourceMap = NodePath.join(workDir, "index.android.bundle.map");
    NodeChildProcess.execFileSync(
      process.execPath,
      [
        NodePath.join(PACKAGE_ROOT, "node_modules/expo/bin/cli"),
        "export:embed",
        "--platform",
        "android",
        "--dev",
        "false",
        "--entry-file",
        "index.ts",
        "--bundle-output",
        output,
        "--sourcemap-output",
        sourceMap,
        "--assets-dest",
        NodePath.join(workDir, "assets"),
      ],
      {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, EXPO_NO_GIT_STATUS: "1", CI: "1", NODE_ENV: "production" },
        stdio: "pipe",
      },
    );
    bundle = NodeFS.readFileSync(output, "latin1");
    sources = (JSON.parse(NodeFS.readFileSync(sourceMap, "utf8")) as { sources: Array<string> })
      .sources;
  }, 240_000);

  afterAll(() => {
    if (workDir !== "") {
      NodeFS.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("is real, and contains no forbidden string beyond the two allowed ones", () => {
    expect(bundle.length).toBeGreaterThan(1_000_000);
    expect(scanBundle(bundle)).toEqual([]);
  });

  it("resolves every package from a single root", () => {
    expect(sources.length).toBeGreaterThan(7_000);
    expect(duplicatePackages(sources)).toEqual([]);
  });
});
