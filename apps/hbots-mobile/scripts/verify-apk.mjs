// @effect-diagnostics nodeBuiltinImport:off - Local release check, runs on the build machine.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { requireReleaseVersion } from "./versionCode.ts";

const REPO_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);

const EXPECTED = {
  applicationId: "com.haroutb5.hbots",
  label: "hbots",
  debuggable: "false",
  allowBackup: "false",
  usesCleartextTraffic: "false",
};

// The template adds these for a dev client. The app never uses them.
const FORBIDDEN_PERMISSIONS = [
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
];

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

const release = requireReleaseVersion(
  NodeFS.readFileSync(NodePath.join(REPO_ROOT, "scripts/personal/app-version.txt"), "utf8").trim(),
  "app-version.txt",
);
const releaseVersion = release.name;
const releaseVersionCode = release.code;

const manifest = analyze("manifest", "print");
const applicationTag = manifest.match(/<application\b[^>]*>/su)?.[0] ?? "";
const attribute = (name) => applicationTag.match(new RegExp(`android:${name}="([^"]*)"`, "u"))?.[1];
const manifestAttribute = (name) =>
  manifest.match(new RegExp(`android:${name}="([^"]*)"`, "u"))?.[1];

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
  versionName: manifestAttribute("versionName"),
  versionCode: manifestAttribute("versionCode"),
};

let failed = false;
for (const [key, expected] of Object.entries(EXPECTED)) {
  const ok = actual[key] === expected;
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} ${key}=${String(actual[key])} (expected ${expected})`);
}

const versionOk =
  actual.versionName === releaseVersion && actual.versionCode === String(releaseVersionCode);
failed ||= !versionOk;
console.log(
  `${versionOk ? "ok  " : "FAIL"} versionName=${String(actual.versionName)} versionCode=${String(actual.versionCode)} (expected ${releaseVersion} / ${String(releaseVersionCode)})`,
);

for (const permission of FORBIDDEN_PERMISSIONS) {
  const present = manifest.includes(permission);
  failed ||= present;
  console.log(`${present ? "FAIL" : "ok  "} ${permission} absent`);
}

const REQUIRED_PERMISSIONS = [
  "android.permission.REQUEST_INSTALL_PACKAGES",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.UPDATE_PACKAGES_WITHOUT_USER_ACTION",
];
for (const permission of REQUIRED_PERMISSIONS) {
  const present = manifest.includes(permission);
  failed ||= !present;
  console.log(`${present ? "ok  " : "FAIL"} ${permission} present`);
}

const components = [
  ...manifest.matchAll(/<(activity|activity-alias|receiver|service|provider)\b[^>]*>/gu),
]
  .map(([tag = ""]) => ({
    name: tag.match(/android:name="([^"]*)"/u)?.[1] ?? "",
    exported: tag.match(/android:exported="([^"]*)"/u)?.[1] ?? "false",
    kind: tag.match(/^<([a-z-]+)/u)?.[1] ?? "",
  }))
  .filter((component) => component.name.length > 0);
const exported = components
  .filter((component) => component.exported === "true")
  .map((component) => component.name);
// ProfileInstallReceiver comes from the baseline-profile dependency the scaffold already shipped.
// ShareActivity is the share target and CtoTileService the Quick Settings tile; both must be exported.
// DebugPushReceiver is the no-Firebase test hook. It must be guarded by the DUMP permission, checked below.
const expectedExported = [
  "com.haroutb5.hbots.MainActivity",
  "expo.modules.hbotsshare.ShareActivity",
  "expo.modules.hbotstile.CtoTileService",
  "expo.modules.hbotsnotify.DebugPushReceiver",
  "androidx.profileinstaller.ProfileInstallReceiver",
];
const exportedOk =
  exported.length === expectedExported.length &&
  expectedExported.every((name) => exported.includes(name));
failed ||= !exportedOk;
console.log(
  `${exportedOk ? "ok  " : "FAIL"} exported=${exported.join(",")} (expected ${expectedExported.join(",")})`,
);

const debugReceiverTag =
  manifest.match(/<receiver\b[^>]*expo\.modules\.hbotsnotify\.DebugPushReceiver[^>]*>/u)?.[0] ?? "";
const debugGuarded = debugReceiverTag.includes('android:permission="android.permission.DUMP"');
failed ||= !debugGuarded;
console.log(`${debugGuarded ? "ok  " : "FAIL"} DebugPushReceiver guarded by DUMP`);

const receiver = components.find(
  (component) => component.name === "expo.modules.hbotsupdater.UpdateInstallReceiver",
);
const receiverOk = receiver?.kind === "receiver" && receiver.exported === "false";
failed ||= !receiverOk;
console.log(
  `${receiverOk ? "ok  " : "FAIL"} UpdateInstallReceiver exported=${receiver?.exported ?? "missing"} (expected false)`,
);

console.log(`dataExtractionRules=${String(attribute("dataExtractionRules"))}`);
console.log(`fullBackupContent=${String(attribute("fullBackupContent"))}`);
console.log(`apk-bytes=${analyze("apk", "file-size")}`);
process.exit(failed ? 1 : 0);
