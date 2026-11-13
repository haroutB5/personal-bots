// @effect-diagnostics nodeBuiltinImport:off - The test runs the build script's shell switch.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

const SCRIPT = NodePath.join(import.meta.dirname, "firebase-env.sh");
const TMP = NodePath.join(process.cwd(), ".tmp");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const tempHome = (withOwnerConfig: boolean) => {
  NodeFS.mkdirSync(TMP, { recursive: true });
  const home = NodeFS.mkdtempSync(NodePath.join(TMP, "firebase-env-"));
  roots.push(home);
  if (withOwnerConfig) {
    NodeFS.mkdirSync(NodePath.join(home, ".config", "hbots"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(home, ".config", "hbots", "google-services.json"), "{}");
  }
  return home;
};

const run = (home: string, configured?: string) => {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home };
  if (configured !== undefined) env.HBOTS_GOOGLE_SERVICES_JSON = configured;
  const out = NodeChildProcess.execFileSync(
    "bash",
    ["-c", 'source "$1"; echo "env=${HBOTS_GOOGLE_SERVICES_JSON:-}"', "_", SCRIPT],
    { env, encoding: "utf8" },
  );
  const [line, exported] = out.trim().split("\n");
  return { line, exported };
};

describe("firebase-env.sh", () => {
  it("turns Firebase on from the owner's config when nothing is set", () => {
    const home = tempHome(true);
    const owner = NodePath.join(home, ".config", "hbots", "google-services.json");
    expect(run(home)).toEqual({
      line: `build-android: Firebase on from ${owner}`,
      exported: `env=${owner}`,
    });
  });

  it("keeps an explicit path over the owner's config", () => {
    const home = tempHome(true);
    const other = NodePath.join(home, "other.json");
    NodeFS.writeFileSync(other, "{}");
    expect(run(home, other)).toEqual({
      line: `build-android: Firebase on from ${other}`,
      exported: `env=${other}`,
    });
  });

  it("says Firebase is off when no config exists", () => {
    expect(run(tempHome(false))).toEqual({
      line: "build-android: Firebase off, no google-services.json (push state unconfigured)",
      exported: "env=",
    });
  });

  it("says Firebase is off when the named file is missing", () => {
    const home = tempHome(true);
    const missing = NodePath.join(home, "missing.json");
    expect(run(home, missing)).toEqual({
      line: `build-android: Firebase off, ${missing} does not exist (push state unconfigured)`,
      exported: `env=${missing}`,
    });
  });
});
