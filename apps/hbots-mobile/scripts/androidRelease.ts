// @effect-diagnostics nodeBuiltinImport:off - Release tooling runs on the build machine.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { parseReleaseVersion, requireReleaseVersion, type ReleaseVersion } from "./versionCode.ts";

export const APK_PACKAGE = "com.haroutb5.hbots";
export const LATEST_SCHEMA = 1;
export const ANDROID_UPDATES_DIR = "android-updates";
export const LATEST_MANIFEST = "latest.json";
export const APK_CONTENT_TYPE = "application/vnd.android.package-archive";
export const NOTES_MAX_LENGTH = 500;
export const MIN_APK_BYTES = 1_000_000;
export const MAX_APK_BYTES = 300_000_000;
export const KEEP_APKS = 3;

const SHA256 = /^[0-9a-f]{64}$/u;

export interface ReleaseArtifact {
  readonly path: string;
  readonly version: ReleaseVersion;
  readonly packageName: string;
  readonly sha256: string;
  readonly size: number;
  readonly signers: ReadonlyArray<string>;
}

export interface LatestRecord {
  readonly schema: typeof LATEST_SCHEMA;
  readonly version: string;
  readonly sha256: string;
  readonly size: number;
  readonly notes: string;
}

export interface ReleaseCheck {
  readonly artifact: ReleaseArtifact;
  readonly expectedVersion: string;
  readonly pinnedSha256: string;
  readonly published: LatestRecord | null;
  readonly minimumNativeVersion: ReleaseVersion | null;
  readonly notes: string;
}

export interface ReadbackReport {
  readonly compatVersion: string;
  readonly compatSha256: string;
  readonly compatSize: number;
  readonly apkBytes: number;
  readonly apkSha256: string;
  readonly contentType: string;
  readonly cacheControl: string;
}

export function sha256File(file: string): string {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
}

function newestDirectory(parent: string): string | undefined {
  if (!NodeFS.existsSync(parent)) return undefined;
  return NodeFS.readdirSync(parent)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .at(-1);
}

export function androidTools(): { readonly apkanalyzer: string; readonly apksigner: string } {
  const sdk = process.env.ANDROID_HOME ?? NodePath.join(process.env.HOME ?? "", "Android/Sdk");
  const buildTools = NodePath.join(sdk, "build-tools");
  const buildToolsVersion = newestDirectory(buildTools);
  if (buildToolsVersion === undefined) throw new Error(`no build-tools under ${buildTools}`);
  const apksigner = NodePath.join(buildTools, buildToolsVersion, "apksigner");
  const analyzerCandidates = [
    NodePath.join(sdk, "cmdline-tools/latest/bin/apkanalyzer"),
    ...(newestDirectory(NodePath.join(sdk, "cmdline-tools")) === undefined
      ? []
      : [
          NodePath.join(
            sdk,
            "cmdline-tools",
            newestDirectory(NodePath.join(sdk, "cmdline-tools")) ?? "",
            "bin/apkanalyzer",
          ),
        ]),
  ];
  const apkanalyzer = analyzerCandidates.find((candidate) => NodeFS.existsSync(candidate));
  if (apkanalyzer === undefined) throw new Error(`no apkanalyzer under ${sdk}/cmdline-tools`);
  if (!NodeFS.existsSync(apksigner)) throw new Error(`no apksigner under ${buildTools}`);
  return { apkanalyzer, apksigner };
}

function run(tool: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync(tool, [...args], { encoding: "utf8" }).trim();
}

export function readArtifact(apkPath: string): ReleaseArtifact {
  const tools = androidTools();
  const versionName = run(tools.apkanalyzer, ["manifest", "version-name", apkPath]);
  const version = parseReleaseVersion(versionName);
  if (version === null) {
    throw new Error(`APK versionName ${versionName} is not x.y.z with each part 0-999`);
  }
  const versionCode = Number(run(tools.apkanalyzer, ["manifest", "version-code", apkPath]));
  if (versionCode !== version.code) {
    throw new Error(`APK versionCode ${String(versionCode)} does not match ${versionName}`);
  }
  const signature = NodeChildProcess.execFileSync(
    tools.apksigner,
    ["verify", "--print-certs", apkPath],
    { encoding: "utf8" },
  );
  const signers = [
    ...signature.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([0-9a-f]{64})$/gmu),
  ]
    .map((match) => match[1] ?? "")
    .filter((digest) => digest.length > 0);
  return {
    path: apkPath,
    version,
    packageName: run(tools.apkanalyzer, ["manifest", "application-id", apkPath]),
    sha256: sha256File(apkPath),
    size: NodeFS.statSync(apkPath).size,
    signers,
  };
}

export function releaseProblems(check: ReleaseCheck): ReadonlyArray<string> {
  const problems: string[] = [];
  const { artifact } = check;
  if (artifact.packageName !== APK_PACKAGE) {
    problems.push(`package is ${artifact.packageName}, expected ${APK_PACKAGE}`);
  }
  if (artifact.version.name !== check.expectedVersion) {
    problems.push(
      `versionName is ${artifact.version.name}, expected app-version.txt ${check.expectedVersion}`,
    );
  }
  if (artifact.size < MIN_APK_BYTES || artifact.size > MAX_APK_BYTES) {
    problems.push(
      `size ${String(artifact.size)} is outside ${String(MIN_APK_BYTES)} to ${String(MAX_APK_BYTES)}`,
    );
  }
  if (artifact.signers.length !== 1) {
    problems.push(`expected one signer, found ${String(artifact.signers.length)}`);
  } else if (artifact.signers[0] !== check.pinnedSha256) {
    problems.push(
      `signer ${artifact.signers[0] ?? ""} does not match release-cert.sha256 ${check.pinnedSha256}`,
    );
  }
  const notes = check.notes.trim();
  if (notes.length === 0) {
    problems.push("notes are empty");
  } else if (notes.length > NOTES_MAX_LENGTH) {
    problems.push(
      `notes are ${String(notes.length)} characters, limit ${String(NOTES_MAX_LENGTH)}`,
    );
  }
  if (check.published !== null) {
    const publishedVersion = parseReleaseVersion(check.published.version);
    if (publishedVersion === null) {
      problems.push(`published version ${check.published.version} is not x.y.z`);
    } else if (artifact.version.code <= publishedVersion.code) {
      problems.push(
        `versionCode ${String(artifact.version.code)} does not increase on published ${check.published.version} (${String(publishedVersion.code)})`,
      );
    }
  }
  if (
    check.minimumNativeVersion !== null &&
    check.minimumNativeVersion.code > artifact.version.code
  ) {
    problems.push(
      `minimumNativeVersion ${check.minimumNativeVersion.name} is above published ${artifact.version.name}`,
    );
  }
  return problems;
}

function decodeLatest(value: unknown, source: string): LatestRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${source} is not a JSON object`);
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== LATEST_SCHEMA) throw new Error(`${source} schema is not ${LATEST_SCHEMA}`);
  if (typeof record.version !== "string" || parseReleaseVersion(record.version) === null) {
    throw new Error(`${source} version is not x.y.z`);
  }
  if (typeof record.sha256 !== "string" || !SHA256.test(record.sha256)) {
    throw new Error(`${source} sha256 is not 64 lowercase hex characters`);
  }
  if (
    typeof record.size !== "number" ||
    !Number.isInteger(record.size) ||
    record.size < MIN_APK_BYTES ||
    record.size > MAX_APK_BYTES
  ) {
    throw new Error(`${source} size is outside the APK bounds`);
  }
  if (typeof record.notes !== "string" || record.notes.length > NOTES_MAX_LENGTH) {
    throw new Error(`${source} notes are missing or too long`);
  }
  return {
    schema: LATEST_SCHEMA,
    version: record.version,
    sha256: record.sha256,
    size: record.size,
    notes: record.notes,
  };
}

export function readPublishedRelease(updatesDir: string): LatestRecord | null {
  const manifestPath = NodePath.join(updatesDir, LATEST_MANIFEST);
  let text: string;
  try {
    text = NodeFS.readFileSync(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return decodeLatest(JSON.parse(text) as unknown, manifestPath);
}

export function readMinimumNativeVersion(repoRoot: string): ReleaseVersion | null {
  const contracts = NodePath.join(repoRoot, "packages/contracts/src/personalClientCompat.ts");
  if (!NodeFS.existsSync(contracts)) return null;
  const source = NodeFS.readFileSync(contracts, "utf8");
  const match =
    /PERSONAL_ANDROID_MINIMUM_NATIVE_VERSION\s*=\s*HbotsVersion\.make\("([^"]+)"\)/u.exec(source);
  if (match === null) throw new Error(`no PERSONAL_ANDROID_MINIMUM_NATIVE_VERSION in ${contracts}`);
  const version = match[1];
  if (version === undefined) throw new Error(`no value for the minimum version in ${contracts}`);
  return requireReleaseVersion(version, contracts);
}

/** Writes to a sibling temp file and renames, so a crash never leaves half a file. */
export function atomicWriteFile(destination: string, write: (fd: number) => void): void {
  const temporary = `${destination}.tmp`;
  const fd = NodeFS.openSync(temporary, "w", 0o600);
  try {
    write(fd);
    NodeFS.fsyncSync(fd);
  } catch (error) {
    NodeFS.closeSync(fd);
    NodeFS.rmSync(temporary, { force: true });
    throw error;
  }
  NodeFS.closeSync(fd);
  NodeFS.renameSync(temporary, destination);
}

function fsyncDirectory(directory: string): void {
  const fd = NodeFS.openSync(directory, "r");
  try {
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
}

export function pruneReleases(
  updatesDir: string,
  keepVersion: string,
  keep: number = KEEP_APKS,
): ReadonlyArray<string> {
  const releases = NodeFS.readdirSync(updatesDir)
    .map((name) => ({ name, match: /^hbots-(\d+\.\d+\.\d+)\.apk$/u.exec(name) }))
    .flatMap((entry) => {
      if (entry.match === null) return [];
      const version = parseReleaseVersion(entry.match[1] ?? "");
      return version === null ? [] : [{ name: entry.name, code: version.code }];
    })
    .sort((left, right) => right.code - left.code);
  const removed: string[] = [];
  for (const release of releases.slice(Math.max(keep, 1))) {
    if (`hbots-${keepVersion}.apk` === release.name) continue;
    NodeFS.rmSync(NodePath.join(updatesDir, release.name), { force: true });
    removed.push(release.name);
  }
  return removed;
}

export function publishRelease(
  updatesDir: string,
  apkPath: string,
  record: LatestRecord,
): {
  readonly apkPath: string;
  readonly manifestPath: string;
  readonly pruned: ReadonlyArray<string>;
} {
  NodeFS.mkdirSync(updatesDir, { recursive: true, mode: 0o700 });
  const destination = NodePath.join(updatesDir, `hbots-${record.version}.apk`);
  if (NodeFS.existsSync(destination)) {
    if (sha256File(destination) !== record.sha256) {
      throw new Error(`${destination} already holds different bytes`);
    }
  } else {
    atomicWriteFile(destination, (fd) => {
      const bytes = NodeFS.readFileSync(apkPath);
      let offset = 0;
      while (offset < bytes.length) {
        offset += NodeFS.writeSync(fd, bytes, offset, bytes.length - offset);
      }
    });
  }
  const manifestPath = NodePath.join(updatesDir, LATEST_MANIFEST);
  atomicWriteFile(manifestPath, (fd) => {
    NodeFS.writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
  });
  fsyncDirectory(updatesDir);
  return { apkPath: destination, manifestPath, pruned: pruneReleases(updatesDir, record.version) };
}

export function readbackOriginProblem(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return `readback ${origin} is not a URL`;
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) {
    return null;
  }
  return "readback must use https, or http on 127.0.0.1";
}

export async function readBack(
  origin: string,
  token: string,
  expected: LatestRecord,
): Promise<ReadbackReport> {
  const originProblem = readbackOriginProblem(origin);
  if (originProblem !== null) throw new Error(originProblem);
  const timeout = AbortSignal.timeout(30_000);
  const compatResponse = await fetch(new URL("/api/personal/client-compat", origin), {
    headers: { accept: "application/json" },
    signal: timeout,
  });
  if (!compatResponse.ok) {
    throw new Error(`client-compat returned ${String(compatResponse.status)}`);
  }
  const compat = (await compatResponse.json()) as {
    readonly android?: {
      readonly latest?: {
        readonly version?: unknown;
        readonly sha256?: unknown;
        readonly size?: unknown;
        readonly notes?: unknown;
      } | null;
    };
  };
  const latest = compat.android?.latest;
  if (latest === null || latest === undefined) {
    throw new Error("client-compat has no android.latest");
  }
  if (latest.version !== expected.version) {
    throw new Error(
      `client-compat version is ${String(latest.version)}, expected ${expected.version}`,
    );
  }
  if (latest.sha256 !== expected.sha256) {
    throw new Error("client-compat sha256 does not match latest.json");
  }
  if (latest.size !== expected.size) {
    throw new Error("client-compat size does not match latest.json");
  }
  const apkResponse = await fetch(
    new URL(`/api/personal/android/apk/${expected.version}`, origin),
    { headers: { authorization: `Bearer ${token}` }, signal: timeout },
  );
  if (apkResponse.status !== 200) {
    throw new Error(`APK route returned ${String(apkResponse.status)}`);
  }
  const contentType = apkResponse.headers.get("content-type") ?? "";
  const cacheControl = apkResponse.headers.get("cache-control") ?? "";
  if (contentType !== APK_CONTENT_TYPE) {
    throw new Error(`APK route content-type is ${contentType}`);
  }
  if (cacheControl !== "private, no-store") {
    throw new Error(`APK route cache-control is ${cacheControl}`);
  }
  const bytes = Buffer.from(await apkResponse.arrayBuffer());
  const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== expected.size) {
    throw new Error(
      `APK route sent ${String(bytes.length)} bytes, expected ${String(expected.size)}`,
    );
  }
  if (sha256 !== expected.sha256) {
    throw new Error(`APK route bytes hash to ${sha256}, expected ${expected.sha256}`);
  }
  return {
    compatVersion: expected.version,
    compatSha256: expected.sha256,
    compatSize: expected.size,
    apkBytes: bytes.length,
    apkSha256: sha256,
    contentType,
    cacheControl,
  };
}
