// @effect-diagnostics nodeBuiltinImport:off - Local release check, runs on the build machine.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

const EXPECTED = {
  applicationId: "com.haroutb5.hbots",
  label: "hbots",
  debuggable: "false",
  allowBackup: "false",
  usesCleartextTraffic: "false",
};

const apk = process.argv[2];
if (apk === undefined) {
  console.error("Usage: node verify-apk.mjs <path-to-apk>");
  process.exit(2);
}
const apkanalyzer = NodePath.join(
  process.env.ANDROID_HOME ?? `${process.env.HOME}/Android/Sdk`,
  "cmdline-tools/latest/bin/apkanalyzer",
);
const analyze = (...args) =>
  NodeChildProcess.execFileSync(apkanalyzer, [...args, apk], { encoding: "utf8" }).trim();

const manifest = analyze("manifest", "print");
const applicationTag = manifest.match(/<application\b[^>]*>/su)?.[0] ?? "";
const attribute = (name) => applicationTag.match(new RegExp(`android:${name}="([^"]*)"`, "u"))?.[1];

// The prebuilt manifest labels the app @string/app_name, which the APK stores as a resource id.
const resolveLabel = (label) =>
  label?.startsWith("@ref/")
    ? analyze("resources", "value", "--config", "default", "--name", "app_name", "--type", "string")
    : label;

const actual = {
  applicationId: analyze("manifest", "application-id"),
  label: resolveLabel(attribute("label")),
  debuggable: analyze("manifest", "debuggable"),
  allowBackup: attribute("allowBackup"),
  usesCleartextTraffic: attribute("usesCleartextTraffic"),
};

let failed = false;
for (const [key, expected] of Object.entries(EXPECTED)) {
  const ok = actual[key] === expected;
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} ${key}=${String(actual[key])} (expected ${expected})`);
}
console.log(`dataExtractionRules=${String(attribute("dataExtractionRules"))}`);
console.log(`fullBackupContent=${String(attribute("fullBackupContent"))}`);
console.log(`apk-bytes=${analyze("apk", "file-size")}`);
process.exit(failed ? 1 : 0);
