// Native fingerprint of android/ (Harout's guard 4): prebuild reruns only when it changes. Covers
// app config, plugins, assets, modules/*/android, the lockfile and patches, Firebase, the QA arch.
// The version is left out: applyVersion rewrites it and verify-apk.mjs checks it in the APK.
// CLI: node nativeFingerprint.ts hash | version <android/app/build.gradle>
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { requireReleaseVersion } from "./versionCode.ts";

// Bump to force every checkout to regenerate once (a change to what prebuild reads).
const FINGERPRINT_VERSION = "1";

const APP_FILES = [
  "app.config.ts",
  "app.json",
  "package.json",
  "src/permissions.ts",
  "scripts/versionCode.ts",
  "scripts/nativeFingerprint.ts",
];
const APP_DIRS = ["plugins", "assets"];
const ROOT_FILES = ["pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", ".npmrc"];
const ROOT_DIRS = ["patches"];
// Inside modules/<name>/: the module's own config and its Android sources, not build outputs
// or JVM unit tests (they never reach the app).
const MODULE_FILES = ["package.json", "expo-module.config.json"];
const SKIP_IN_MODULE_ANDROID = /(^|\/)(build|\.gradle|\.cxx)(\/|$)|^src\/test\//;

const ENV_INPUTS = ["HBOTS_QA_X86", "HBOTS_GOOGLE_SERVICES_JSON"];

function walk(dir: string, rel = ""): string[] {
  let entries: NodeFS.Dirent[];
  try {
    entries = NodeFS.readdirSync(NodePath.join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(dir, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

export interface FingerprintInput {
  appDir: string;
  repoRoot: string;
  env: Record<string, string | undefined>;
}

/** The list of [label, sha256] pairs the fingerprint is made of, in a fixed order. */
export function fingerprintParts({ appDir, repoRoot, env }: FingerprintInput): string[][] {
  const parts: string[][] = [["fingerprint", FINGERPRINT_VERSION]];
  const file = (label: string, path: string) => {
    if (!NodeFS.existsSync(path)) return parts.push([label, "absent"]);
    parts.push([
      label,
      NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex"),
    ]);
  };
  for (const name of APP_FILES) {
    if (name === "package.json") packageJson(`app:${name}`, NodePath.join(appDir, name));
    else file(`app:${name}`, NodePath.join(appDir, name));
  }
  // The app package.json without its "version": every release bumps it, and the native
  // version comes from app-version.txt (applyVersion), so hashing it raw made every release's
  // first build a clean prebuild (1.67.53).
  function packageJson(label: string, path: string) {
    if (!NodeFS.existsSync(path)) return parts.push([label, "absent"]);
    const { version: _version, ...rest } = JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    parts.push([label, NodeCrypto.createHash("sha256").update(JSON.stringify(rest)).digest("hex")]);
  }
  for (const dir of APP_DIRS)
    for (const rel of walk(NodePath.join(appDir, dir)).sort())
      file(`app:${dir}/${rel}`, NodePath.join(appDir, dir, rel));
  for (const name of ROOT_FILES) file(`root:${name}`, NodePath.join(repoRoot, name));
  for (const dir of ROOT_DIRS)
    for (const rel of walk(NodePath.join(repoRoot, dir)).sort())
      file(`root:${dir}/${rel}`, NodePath.join(repoRoot, dir, rel));
  const modulesDir = NodePath.join(appDir, "modules");
  const modules = NodeFS.existsSync(modulesDir) ? NodeFS.readdirSync(modulesDir).sort() : [];
  for (const name of modules) {
    const moduleDir = NodePath.join(modulesDir, name);
    if (!NodeFS.statSync(moduleDir).isDirectory()) continue;
    for (const config of MODULE_FILES)
      file(`module:${name}/${config}`, NodePath.join(moduleDir, config));
    for (const rel of walk(NodePath.join(moduleDir, "android")).sort()) {
      if (SKIP_IN_MODULE_ANDROID.test(rel)) continue;
      file(`module:${name}/android/${rel}`, NodePath.join(moduleDir, "android", rel));
    }
  }
  for (const name of ENV_INPUTS) parts.push([`env:${name}`, env[name] ?? ""]);
  // The Firebase file is copied into android/ by prebuild: its content counts, not just its path.
  const firebase = (env.HBOTS_GOOGLE_SERVICES_JSON ?? "").trim();
  if (firebase) file("env:HBOTS_GOOGLE_SERVICES_JSON content", firebase);
  return parts;
}

export function nativeFingerprint(input: FingerprintInput): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const [label, value] of fingerprintParts(input)) hash.update(`${label}\0${value}\n`);
  return hash.digest("hex");
}

/**
 * Rewrite versionCode and versionName in android/app/build.gradle to the release version, for a
 * build that skipped prebuild. Each line must match exactly once, or it throws and the caller
 * regenerates android/ instead.
 */
export function applyVersion(gradleText: string, versionText: string): string {
  const { name, code } = requireReleaseVersion(versionText.trim(), "app-version.txt");
  const codeLines = gradleText.match(/^\s*versionCode \d+\s*$/gm) ?? [];
  const nameLines = gradleText.match(/^\s*versionName "[^"]*"\s*$/gm) ?? [];
  if (codeLines.length !== 1 || nameLines.length !== 1)
    throw new Error(
      `build.gradle has ${codeLines.length} versionCode and ${nameLines.length} versionName lines, expected one each`,
    );
  return gradleText
    .replace(/^(\s*)versionCode \d+(\s*)$/m, `$1versionCode ${code}$2`)
    .replace(/^(\s*)versionName "[^"]*"(\s*)$/m, `$1versionName "${name}"$2`);
}

const isMain =
  process.argv[1] && NodePath.resolve(process.argv[1]) === NodePath.resolve(import.meta.filename);
if (isMain) {
  const appDir = NodePath.resolve(import.meta.dirname, "..");
  const repoRoot = NodePath.resolve(appDir, "../..");
  const [command, target] = process.argv.slice(2);
  if (command === "hash") {
    console.log(nativeFingerprint({ appDir, repoRoot, env: process.env }));
  } else if (command === "version" && target) {
    const versionText = NodeFS.readFileSync(
      NodePath.join(repoRoot, "scripts/personal/app-version.txt"),
      "utf8",
    );
    NodeFS.writeFileSync(target, applyVersion(NodeFS.readFileSync(target, "utf8"), versionText));
  } else {
    console.error("usage: nativeFingerprint.ts hash | version <android/app/build.gradle>");
    process.exit(2);
  }
}
