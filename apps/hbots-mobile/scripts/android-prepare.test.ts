// @effect-diagnostics nodeBuiltinImport:off - Runs android-prepare.sh on a throwaway checkout.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

const script = NodePath.join(import.meta.dirname, "android-prepare.sh");
const roots: string[] = [];

// A checkout (a git repo) inside a parent folder, with stand-ins for `node scripts/nativeFingerprint.ts`
// (prints FAKE_FP) and `npx expo prebuild --clean` (recreates android/ and logs the call).
function checkout() {
  const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-android-prepare-"));
  roots.push(parent);
  const top = NodePath.join(parent, "slot");
  const app = NodePath.join(top, "apps/hbots-mobile");
  const bin = NodePath.join(parent, "bin");
  NodeFS.mkdirSync(app, { recursive: true });
  NodeFS.mkdirSync(bin);
  NodeChildProcess.execFileSync("git", ["init", "-q", top]);
  const log = NodePath.join(parent, "prebuild.log");
  NodeFS.writeFileSync(
    NodePath.join(bin, "node"),
    '#!/usr/bin/env bash\ncase $2 in hash) echo "$FAKE_FP";; version) exit 0;; *) exit 9;; esac\n',
    { mode: 0o755 },
  );
  NodeFS.writeFileSync(
    NodePath.join(bin, "npx"),
    `#!/usr/bin/env bash\necho "prebuild $FAKE_FP" >> '${log}'\nrm -rf android\nmkdir -p android/app\necho gradle > android/app/build.gradle\necho "$FAKE_FP" > android/built-for\n`,
    { mode: 0o755 },
  );
  const alt = NodePath.join(parent, ".slot.android-alt");
  const prepare = (fp: string, extra: Record<string, string> = {}) =>
    NodeChildProcess.execFileSync(
      "bash",
      ["-euo", "pipefail", "-c", `source '${script}'; hbots_android_prepare`],
      {
        cwd: app,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_FP: fp, ...extra },
      },
    );
  const builtFor = (dir: string) => {
    try {
      return NodeFS.readFileSync(NodePath.join(dir, "built-for"), "utf8").trim();
    } catch {
      return null;
    }
  };
  const prebuilds = () =>
    NodeFS.existsSync(log) ? NodeFS.readFileSync(log, "utf8").trim().split("\n") : [];
  return {
    app,
    alt,
    prepare,
    prebuilds,
    android: () => builtFor(NodePath.join(app, "android")),
    parked: () => builtFor(alt),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("android-prepare.sh", () => {
  it("parks the other flavour's android/ and moves it back instead of a clean prebuild", () => {
    const c = checkout();
    c.prepare("arm64fp");
    expect(c.prebuilds()).toEqual(["prebuild arm64fp"]);
    // The x86 QA build: a different fingerprint. The arm64 tree is parked, not wiped.
    const x86 = c.prepare("x86fp");
    expect(x86).toContain("parked in");
    expect(c.android()).toBe("x86fp");
    expect(c.parked()).toBe("arm64fp");
    // The next arm64 build gets its own tree back with no prebuild, and so does x86 after it.
    const arm = c.prepare("arm64fp");
    expect(arm).toContain("moved back from");
    expect(arm).toContain("prebuild skipped");
    expect(c.android()).toBe("arm64fp");
    expect(c.parked()).toBe("x86fp");
    c.prepare("x86fp");
    expect(c.android()).toBe("x86fp");
    expect(c.prebuilds()).toEqual(["prebuild arm64fp", "prebuild x86fp"]);
  });

  it("on a native change replaces the older parked tree and keeps the latest other one", () => {
    const c = checkout();
    c.prepare("armA");
    c.prepare("x86A");
    // The native config changed: arm64 gets a new fingerprint. The stale arm64 tree is the one
    // prebuild --clean replaces; the x86 tree stays parked.
    c.prepare("armB");
    expect(c.android()).toBe("armB");
    expect(c.parked()).toBe("x86A");
    expect(c.prebuilds()).toEqual(["prebuild armA", "prebuild x86A", "prebuild armB"]);
  });

  it("HBOTS_ANDROID_ALT=off keeps the old in-place prebuild", () => {
    const c = checkout();
    c.prepare("armA", { HBOTS_ANDROID_ALT: "off" });
    c.prepare("x86A", { HBOTS_ANDROID_ALT: "off" });
    expect(c.android()).toBe("x86A");
    expect(NodeFS.existsSync(c.alt)).toBe(false);
  });

  it("puts back a swap that was cut short", () => {
    const c = checkout();
    c.prepare("armA");
    c.prepare("x86A");
    // Killed between the first and second rename: android/ is at <alt>.swap.
    NodeFS.renameSync(NodePath.join(c.app, "android"), `${c.alt}.swap`);
    const out = c.prepare("x86A");
    expect(out).toContain("prebuild skipped");
    expect(c.android()).toBe("x86A");
    expect(c.parked()).toBe("armA");
    expect(NodeFS.existsSync(`${c.alt}.swap`)).toBe(false);
  });
});
