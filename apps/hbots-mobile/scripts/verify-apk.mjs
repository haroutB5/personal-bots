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
  "android.permission.RECORD_AUDIO",
  "android.permission.FOREGROUND_SERVICE_MICROPHONE",
  // Live Updates on Android 16 (X3): lets the working notification ask to be promoted.
  "android.permission.POST_PROMOTED_NOTIFICATIONS",
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
// The widget providers are the home screen widgets; the launcher must be able to reach them, checked below.
// DebugPushReceiver is the no-Firebase test hook. It must be guarded by the DUMP permission, checked below.
const widgetProviders = [
  "HbotsWidgetProvider",
  "NeedsYouWidgetProvider",
  "TileGridWidgetProvider",
  "QuickAskWidgetProvider",
  "UsageWidgetProvider",
  "OneBotWidgetProvider",
  "MachinesWidgetProvider",
  "TodayWidgetProvider",
];
const expectedExported = [
  "com.haroutb5.hbots.MainActivity",
  "expo.modules.hbotsshare.ShareActivity",
  "expo.modules.hbotstile.CtoTileService",
  "expo.modules.hbotsnotify.DebugPushReceiver",
  ...widgetProviders.map((name) => `expo.modules.hbotslauncher.${name}`),
  "expo.modules.hbotslauncher.ShortcutTrampolineActivity", // forwards hbots:// links only
  "androidx.profileinstaller.ProfileInstallReceiver",
];
// A build with Firebase on adds Google's message receiver. It is exported so Play services can
// deliver a push, and it must stay behind Google's own SEND permission, checked below. A build
// without Firebase has no such receiver, so it is allowed, not required.
const FCM_RECEIVER = "com.google.firebase.iid.FirebaseInstanceIdReceiver";
if (exported.includes(FCM_RECEIVER)) expectedExported.push(FCM_RECEIVER);
const exportedOk =
  exported.length === expectedExported.length &&
  expectedExported.every((name) => exported.includes(name));
failed ||= !exportedOk;
console.log(
  `${exportedOk ? "ok  " : "FAIL"} exported=${exported.join(",")} (expected ${expectedExported.join(",")})`,
);

// Picture-in-picture (X5) is on the main activity only: no other component may enter PiP.
const pipComponents = [...manifest.matchAll(/<(?:activity|activity-alias)\b[^>]*>/gu)]
  .map(([tag = ""]) => tag)
  .filter((tag) => tag.includes('android:supportsPictureInPicture="true"'))
  .map((tag) => tag.match(/android:name="([^"]*)"/u)?.[1] ?? "");
const pipOk = pipComponents.length === 1 && pipComponents[0] === "com.haroutb5.hbots.MainActivity";
failed ||= !pipOk;
console.log(
  `${pipOk ? "ok  " : "FAIL"} supportsPictureInPicture on ${pipComponents.join(",") || "none"} (expected MainActivity only)`,
);

if (exported.includes(FCM_RECEIVER)) {
  const fcmReceiverTag =
    manifest.match(
      /<receiver\b[^>]*com\.google\.firebase\.iid\.FirebaseInstanceIdReceiver[^>]*>/u,
    )?.[0] ?? "";
  const fcmGuarded = fcmReceiverTag.includes(
    'android:permission="com.google.android.c2dm.permission.SEND"',
  );
  failed ||= !fcmGuarded;
  console.log(`${fcmGuarded ? "ok  " : "FAIL"} FirebaseInstanceIdReceiver guarded by c2dm SEND`);
}

const debugReceiverTag =
  manifest.match(/<receiver\b[^>]*expo\.modules\.hbotsnotify\.DebugPushReceiver[^>]*>/u)?.[0] ?? "";
const debugGuarded = debugReceiverTag.includes('android:permission="android.permission.DUMP"');
failed ||= !debugGuarded;
console.log(`${debugGuarded ? "ok  " : "FAIL"} DebugPushReceiver guarded by DUMP`);

// Each widget receiver is exported for the launcher, takes no permission, and answers only the
// widget update broadcast. Anything else in its filter would let other apps drive it.
for (const provider of widgetProviders) {
  const widgetBlock =
    manifest.match(
      new RegExp(
        `<receiver\\b[^>]*expo\\.modules\\.hbotslauncher\\.${provider}"[\\s\\S]*?</receiver>`,
        "u",
      ),
    )?.[0] ?? "";
  const widgetActions = [...widgetBlock.matchAll(/<action\b[^>]*android:name="([^"]*)"/gu)].map(
    ([, name]) => name,
  );
  const widgetTag = widgetBlock.match(/^<receiver\b[^>]*>/u)?.[0] ?? "";
  const widgetOk =
    widgetTag.includes('android:exported="true"') &&
    !widgetTag.includes("android:permission=") &&
    widgetActions.length === 1 &&
    widgetActions[0] === "android.appwidget.action.APPWIDGET_UPDATE" &&
    widgetBlock.includes("android.appwidget.provider");
  failed ||= !widgetOk;
  console.log(
    `${widgetOk ? "ok  " : "FAIL"} ${provider} exported, no permission, actions=${widgetActions.join(",") || "none"} (expected APPWIDGET_UPDATE only)`,
  );
}

const receiver = components.find(
  (component) => component.name === "expo.modules.hbotsupdater.UpdateInstallReceiver",
);
const receiverOk = receiver?.kind === "receiver" && receiver.exported === "false";
failed ||= !receiverOk;
console.log(
  `${receiverOk ? "ok  " : "FAIL"} UpdateInstallReceiver exported=${receiver?.exported ?? "missing"} (expected false)`,
);

const voiceService = components.find(
  (component) => component.name === "expo.modules.hbotsvoice.VoiceCallService",
);
const voiceServiceTag =
  manifest.match(/<service\b[^>]*expo\.modules\.hbotsvoice\.VoiceCallService[^>]*>/u)?.[0] ?? "";
const voiceServiceOk =
  voiceService?.kind === "service" &&
  voiceService.exported === "false" &&
  /android:foregroundServiceType="(?:microphone|0x80)"/u.test(voiceServiceTag);
failed ||= !voiceServiceOk;
console.log(
  `${voiceServiceOk ? "ok  " : "FAIL"} VoiceCallService exported=${voiceService?.exported ?? "missing"} (expected false, microphone type 0x80)`,
);

console.log(`dataExtractionRules=${String(attribute("dataExtractionRules"))}`);
console.log(`fullBackupContent=${String(attribute("fullBackupContent"))}`);
console.log(`apk-bytes=${analyze("apk", "file-size")}`);
process.exit(failed ? 1 : 0);
