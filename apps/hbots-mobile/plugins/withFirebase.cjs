const fs = require("node:fs");
const path = require("node:path");
const {
  AndroidConfig,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withProjectBuildGradle,
} = require("expo/config-plugins");

// The one Firebase switch. HBOTS_GOOGLE_SERVICES_JSON names a google-services.json outside the
// repo. Unset or missing means no Firebase line in the build and PushState "unconfigured".
// Set means the file is copied in, the google-services plugin applied and the service declared.
// The file is never committed.
const ENV_NAME = "HBOTS_GOOGLE_SERVICES_JSON";
const SERVICE_NAME = "expo.modules.hbotsnotify.HbotsMessagingService";
const META_NAME = "hbots.fcm.configured";
const MESSAGING_ACTION = "com.google.firebase.MESSAGING_EVENT";
const GOOGLE_SERVICES_VERSION = "4.4.4";
const CLASSPATH_LINE = `classpath('com.google.gms:google-services:${GOOGLE_SERVICES_VERSION}')`;
const APPLY_LINE = 'apply plugin: "com.google.gms.google-services"';
const COPY_NAME = "google-services.json";

/**
 * Decides whether this prebuild has a Firebase config. Pure, so the three outcomes are tested.
 * An unset or missing path is "unconfigured". A file that exists but is not usable throws,
 * because the owner asked for Firebase and a quiet fallback would hide the mistake.
 */
function resolveFirebase(env, packageName, fileSystem = fs) {
  const raw = (env[ENV_NAME] ?? "").trim();
  if (raw.length === 0) return { configured: false, reason: "unset" };
  const source = path.resolve(raw);
  if (!fileSystem.existsSync(source)) {
    return { configured: false, reason: "missing", source };
  }
  let parsed;
  try {
    parsed = JSON.parse(fileSystem.readFileSync(source, "utf8"));
  } catch {
    throw new Error(`${ENV_NAME} points at a file that is not valid JSON.`);
  }
  const clients = Array.isArray(parsed?.client) ? parsed.client : [];
  if (typeof parsed?.project_info?.project_id !== "string" || clients.length === 0) {
    throw new Error(
      `${ENV_NAME} does not look like a google-services.json (no project_info or client).`,
    );
  }
  const names = clients.map((c) => c?.client_info?.android_client_info?.package_name);
  if (packageName !== undefined && !names.includes(packageName)) {
    throw new Error(
      `${ENV_NAME} has no client for the app id ${packageName}. It has: ${names.filter(Boolean).join(", ") || "none"}.`,
    );
  }
  return { configured: true, source };
}

function serviceEntry() {
  return {
    $: { "android:name": SERVICE_NAME, "android:exported": "false" },
    "intent-filter": [{ action: [{ $: { "android:name": MESSAGING_ACTION } }] }],
  };
}

/** Adds or removes the messaging service and records the build's answer in a meta-data. */
function applyFirebaseManifest(manifest, configured) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  const services = (application.service ??= []).filter(
    (entry) => entry.$["android:name"] !== SERVICE_NAME,
  );
  if (configured) services.push(serviceEntry());
  application.service = services;
  const metas = (application["meta-data"] ??= []).filter(
    (entry) => entry.$["android:name"] !== META_NAME,
  );
  metas.push({ $: { "android:name": META_NAME, "android:value": configured ? "true" : "false" } });
  application["meta-data"] = metas;
  return manifest;
}

/** Adds or removes the google-services classpath in the root build.gradle. Safe to run twice. */
function applyProjectGradle(contents, configured) {
  const without = contents.replace(
    new RegExp(`\\n[ \\t]*${escapeRegex(CLASSPATH_LINE)}[ \\t]*(?=\\n)`, "g"),
    "",
  );
  if (!configured) return without;
  const anchor = /(buildscript\s*\{[\s\S]*?dependencies\s*\{)/;
  if (!anchor.test(without)) {
    throw new Error(
      "Could not find buildscript dependencies in android/build.gradle to add google-services.",
    );
  }
  return without.replace(anchor, `$1\n    ${CLASSPATH_LINE}`);
}

/** Adds or removes the google-services plugin line at the end of app/build.gradle. */
function applyAppGradle(contents, configured) {
  const without = contents.replace(new RegExp(`\\n*${escapeRegex(APPLY_LINE)}[ \\t]*`, "g"), "");
  return configured ? `${without.replace(/\s*$/, "")}\n\n${APPLY_LINE}\n` : without;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function configureFirebase(config, { env, fileSystem }) {
  const packageName = config.android?.package;
  const state = resolveFirebase(env, packageName, fileSystem);
  if (!state.configured && state.reason === "missing") {
    console.warn(`${ENV_NAME} is set but the file does not exist. Building without Firebase.`);
  }

  config = withAndroidManifest(config, (next) => {
    next.modResults = applyFirebaseManifest(next.modResults, state.configured);
    return next;
  });
  config = withProjectBuildGradle(config, (next) => {
    next.modResults.contents = applyProjectGradle(next.modResults.contents, state.configured);
    return next;
  });
  config = withAppBuildGradle(config, (next) => {
    next.modResults.contents = applyAppGradle(next.modResults.contents, state.configured);
    return next;
  });
  return withDangerousMod(config, [
    "android",
    async (next) => {
      const target = path.join(next.modRequest.platformProjectRoot, "app", COPY_NAME);
      if (state.configured) {
        fs.copyFileSync(state.source, target);
      } else if (fs.existsSync(target)) {
        // A stale copy from an earlier prebuild would make Gradle think Firebase is configured.
        fs.rmSync(target);
      }
      return next;
    },
  ]);
}

function withFirebase(config) {
  return configureFirebase(config, { env: process.env, fileSystem: fs });
}

module.exports = withFirebase;
module.exports.configureFirebase = configureFirebase;
module.exports.resolveFirebase = resolveFirebase;
module.exports.applyFirebaseManifest = applyFirebaseManifest;
module.exports.applyProjectGradle = applyProjectGradle;
module.exports.applyAppGradle = applyAppGradle;
module.exports.ENV_NAME = ENV_NAME;
module.exports.SERVICE_NAME = SERVICE_NAME;
module.exports.META_NAME = META_NAME;
