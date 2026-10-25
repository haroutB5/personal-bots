// @effect-diagnostics nodeBuiltinImport:off
/**
 * One pin, four places.
 *
 * The DeepSeek Harness is installed from the committed runtime files and
 * checked against the engine constant, so the version has to agree in all of
 * them: `DSH_PINNED_VERSION`, the runtime `package.json`, its lockfile and the
 * installer's own default. Drift is invisible to the provider tests (they read
 * the constant) and shows up only as a card that calls a good install wrong, so
 * it is guarded here.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { expect, it } from "@effect/vitest";

import { DSH_PINNED_VERSION, DSH_RUNTIME_DIR_NAME } from "./DeepSeekEngine.ts";

const runtimeDir = NodeURL.fileURLToPath(
  new URL("../../../../../scripts/personal/dsh-runtime", import.meta.url),
);

it("pins the same DeepSeek Harness version in the engine, the runtime files and the installer", () => {
  const pkg = JSON.parse(
    NodeFS.readFileSync(NodePath.join(runtimeDir, "package.json"), "utf8"),
  ) as {
    dependencies: Record<string, string>;
  };
  const lock = JSON.parse(
    NodeFS.readFileSync(NodePath.join(runtimeDir, "package-lock.json"), "utf8"),
  ) as {
    packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
  };
  const installer = NodeFS.readFileSync(NodePath.join(runtimeDir, "..", "install-dsh.ps1"), "utf8");

  expect(pkg.dependencies["@deepseek-ai/dsh"]).toBe(DSH_PINNED_VERSION);
  expect(lock.packages[""]?.dependencies?.["@deepseek-ai/dsh"]).toBe(DSH_PINNED_VERSION);
  expect(lock.packages["node_modules/@deepseek-ai/dsh"]?.version).toBe(DSH_PINNED_VERSION);
  expect(installer).toContain(`[string]$Version = '${DSH_PINNED_VERSION}'`);
  expect(DSH_RUNTIME_DIR_NAME).toBe(`dsh-${DSH_PINNED_VERSION}`);
});
