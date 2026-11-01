// @effect-diagnostics nodeBuiltinImport:off - Reads the package tree under test.
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { FORBIDDEN_RULES, scanPackage, scanText } from "./forkHygiene";

const PACKAGE_ROOT = NodePath.resolve(__dirname, "..");

const PLANTED: ReadonlyArray<readonly [ruleId: string, line: string]> = [
  ["upstream-package-id", 'package: "com.t3tools.t3code"'],
  ["upstream-deep-link", 'const home = "t3code://pair"'],
  ["expo-updates-url", 'url: "https://u.expo.dev/d763fcb8-0000"'],
  ["axiom-tracing", 'import { Axiom } from "@axiomhq/js"'],
  ["axiom-tracing", "EXPO_PUBLIC_AXIOM_TOKEN=abc"],
  ["upstream-relay-push", "await getDevicePushTokenAsync()"],
  ["upstream-relay-push", 'googleServicesFile: "./google-services.json"'],
  ["eas-project", 'extra: { eas: { projectId: "1234" } }'],
  ["eas-project", 'owner: "pingdotgg"'],
  ["upstream-host", "https://t3.codes/terms"],
  ["clerk-sign-in", 'import { ClerkProvider } from "@clerk/expo"'],
  ["tailscale", "Can't reach your laptop. Is Tailscale on?"],
];

describe("fork hygiene rules", () => {
  it.each(PLANTED)("%s flags %s", (ruleId, line) => {
    expect(scanText("planted.ts", line).map((finding) => finding.ruleId)).toContain(ruleId);
  });

  it("reports the file and 1-based line of a hit", () => {
    expect(scanText("src/App.tsx", 'ok\nconst a = "t3code://x"\nok')).toEqual([
      {
        ruleId: "upstream-deep-link",
        file: "src/App.tsx",
        line: 2,
        text: 'const a = "t3code://x"',
      },
    ]);
  });

  it("passes this app's own identifiers", () => {
    const own = [
      'package: "com.haroutb5.hbots"',
      'scheme: "hbots"',
      "updates: { enabled: false }",
      'import { AuthAccessTokenResult } from "@t3tools/contracts"',
    ].join("\n");
    expect(scanText("app.config.ts", own)).toEqual([]);
  });

  it("has a planted case for every rule", () => {
    const covered = new Set(PLANTED.map(([ruleId]) => ruleId));
    expect(FORBIDDEN_RULES.map((rule) => rule.id).filter((id) => !covered.has(id))).toEqual([]);
  });
});

describe("apps/hbots-mobile tree", () => {
  it("contains nothing the upstream fork carried", () => {
    expect(scanPackage(PACKAGE_ROOT)).toEqual([]);
  });
});
