// @effect-diagnostics nodeBuiltinImport:off - Release tooling runs on the build machine.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  ANDROID_UPDATES_DIR,
  LATEST_SCHEMA,
  outputDirProblem,
  publishRelease,
  readArtifact,
  readBack,
  readMinimumNativeVersion,
  readPublishedRelease,
  releaseProblems,
} from "./androidRelease.ts";
import { requireReleaseVersion } from "./versionCode.ts";

const USAGE =
  'Usage: node publish-android-update.mjs <signed.apk> --out <data-root> --notes "<text>" [--minimum-native-version x.y.z] [--readback https://host]';

const args = process.argv.slice(2);
let apk;
const options = { notes: undefined, out: undefined, minimum: undefined, readback: undefined };

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  const value = () => {
    const next = args[index + 1];
    if (next === undefined) throw new Error(`${arg} needs a value`);
    index += 1;
    return next;
  };
  if (arg === "--notes") options.notes = value();
  else if (arg === "--out") options.out = value();
  else if (arg === "--minimum-native-version") options.minimum = value();
  else if (arg === "--readback") options.readback = value();
  else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
  else if (apk === undefined) apk = arg;
  else throw new Error(`unexpected argument ${arg}`);
}

const fail = (message) => {
  console.error(`publish-android-update: ${message}`);
  process.exit(1);
};

if (apk === undefined || options.out === undefined || options.notes === undefined) {
  console.error(USAGE);
  process.exit(2);
}

const outProblem = outputDirProblem(options.out);
if (outProblem !== null) {
  console.error(`publish-android-update: ${outProblem}`);
  console.error(USAGE);
  process.exit(2);
}

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);
const appDir = NodePath.join(repoRoot, "apps/hbots-mobile");

const expectedVersion = requireReleaseVersion(
  NodeFS.readFileSync(NodePath.join(repoRoot, "scripts/personal/app-version.txt"), "utf8").trim(),
  "app-version.txt",
).name;
const pinnedSha256 = NodeFS.readFileSync(
  NodePath.join(appDir, "release-cert.sha256"),
  "utf8",
).trim();
if (!/^[0-9a-f]{64}$/u.test(pinnedSha256)) {
  fail("release-cert.sha256 is not a lowercase sha256");
}

let minimumNativeVersion;
try {
  minimumNativeVersion =
    options.minimum === undefined
      ? readMinimumNativeVersion(repoRoot)
      : requireReleaseVersion(options.minimum, "--minimum-native-version");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (minimumNativeVersion === null) {
  fail(
    "--minimum-native-version is required: packages/contracts/src/personalClientCompat.ts is not on this branch",
  );
}

const updatesDir = NodePath.join(options.out, ANDROID_UPDATES_DIR);
const artifact = readArtifact(apk);
const published = readPublishedRelease(updatesDir);
const notes = options.notes.trim();

const problems = releaseProblems({
  artifact,
  expectedVersion,
  pinnedSha256,
  published,
  minimumNativeVersion,
  notes,
});
if (problems.length > 0) {
  for (const problem of problems) console.error(`refused: ${problem}`);
  process.exit(1);
}

const record = {
  schema: LATEST_SCHEMA,
  version: artifact.version.name,
  sha256: artifact.sha256,
  size: artifact.size,
  notes,
};
let written;
try {
  written = publishRelease(updatesDir, apk, record);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

console.log(`version=${record.version}`);
console.log(`apk=${written.apkPath}`);
console.log(`apk-bytes=${String(record.size)}`);
console.log(`apk-sha256=${record.sha256}`);
console.log(`signer-sha256=${artifact.signers[0] ?? ""}`);
console.log(`manifest=${written.manifestPath}`);
console.log(`pruned=${written.pruned.join(",") || "none"}`);
console.log(`minimum-native-version=${minimumNativeVersion.name}`);

if (options.readback !== undefined) {
  const token = process.env.HBOTS_READBACK_TOKEN;
  if (token === undefined || token.length === 0) {
    fail("--readback needs HBOTS_READBACK_TOKEN");
  }
  const report = await readBack(options.readback, token, record);
  console.log(`compat-version=${report.compatVersion}`);
  console.log(`compat-sha256=${report.compatSha256}`);
  console.log(`compat-size=${String(report.compatSize)}`);
  console.log(`apk-route-bytes=${String(report.apkBytes)}`);
  console.log(`apk-route-sha256=${report.apkSha256}`);
  console.log(`apk-route-content-type=${report.contentType}`);
  console.log(`apk-route-cache-control=${report.cacheControl}`);
}
