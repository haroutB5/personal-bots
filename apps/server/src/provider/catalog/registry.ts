/**
 * The official ACP registry (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
 * decoded into the few shapes the catalogue and installer need.
 *
 * Format: https://github.com/agentclientprotocol/registry/blob/main/FORMAT.md
 *
 * The registry is third-party input. Each agent is decoded on its own, so one
 * malformed entry is skipped (and counted) instead of taking the whole list
 * down; a file that is not a registry at all, or that decodes to no agent,
 * is a failure and the caller keeps its cached copy.
 *
 * @module provider/catalog/registry
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

/** A registry document larger than this is not a registry (the real one is about 57 KB). */
export const REGISTRY_MAX_BYTES = 4 * 1024 * 1024;

const Sha256Hex = Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{64}$/u));
const StringList = Schema.Array(Schema.String);
const StringRecord = Schema.Record(Schema.String, Schema.String);

const BinaryTargetSchema = Schema.Struct({
  archive: Schema.String,
  cmd: Schema.String,
  sha256: Schema.optionalKey(Sha256Hex),
  args: Schema.optionalKey(StringList),
  env: Schema.optionalKey(StringRecord),
});

const PackageDistributionSchema = Schema.Struct({
  package: Schema.String,
  args: Schema.optionalKey(StringList),
  env: Schema.optionalKey(StringRecord),
});

const AgentSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  description: Schema.optionalKey(Schema.String),
  repository: Schema.optionalKey(Schema.String),
  website: Schema.optionalKey(Schema.String),
  authors: Schema.optionalKey(StringList),
  license: Schema.optionalKey(Schema.String),
  license_url: Schema.optionalKey(Schema.String),
  icon: Schema.optionalKey(Schema.String),
  distribution: Schema.Struct({
    // Per-platform targets are decoded one by one below, so a platform we do
    // not run on cannot invalidate the agent.
    binary: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    npx: Schema.optionalKey(Schema.Unknown),
    uvx: Schema.optionalKey(Schema.Unknown),
  }),
});

const Envelope = Schema.Struct({
  version: Schema.String,
  agents: Schema.Array(Schema.Unknown),
});

const decodeEnvelope = Schema.decodeUnknownOption(Envelope);
const decodeAgent = Schema.decodeUnknownOption(AgentSchema);
const decodeBinaryTarget = Schema.decodeUnknownOption(BinaryTargetSchema);
const decodePackage = Schema.decodeUnknownOption(PackageDistributionSchema);

/** ACP registry platform keys. */
export type RegistryPlatform =
  | "darwin-aarch64"
  | "darwin-x86_64"
  | "linux-aarch64"
  | "linux-x86_64"
  | "windows-aarch64"
  | "windows-x86_64";

export function registryPlatformKey(platform: string, arch: string): RegistryPlatform | null {
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  if (cpu === null) return null;
  const os =
    platform === "win32"
      ? "windows"
      : platform === "darwin" || platform === "linux"
        ? platform
        : null;
  return os === null ? null : (`${os}-${cpu}` as RegistryPlatform);
}

export interface RegistryBinaryTarget {
  readonly archive: string;
  readonly cmd: string;
  /** Lower-case hex of the archive's SHA-256, when the registry lists one. */
  readonly sha256: string | null;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export interface RegistryPackage {
  /** The registry's `package` string, for example `@google/gemini-cli@0.64.0`. */
  readonly spec: string;
  /** Package name without the version. Null when the spec is not `name@exact-version`. */
  readonly name: string | null;
  /** Exact pinned version. Null when the spec is a range, tag, URL or alias. */
  readonly version: string | null;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export interface RegistryAgent {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly repository: string | null;
  readonly website: string | null;
  readonly authors: ReadonlyArray<string>;
  readonly license: string | null;
  readonly licenseUrl: string | null;
  readonly icon: string | null;
  readonly binary: Readonly<Partial<Record<RegistryPlatform, RegistryBinaryTarget>>>;
  readonly npm: RegistryPackage | null;
  readonly uvx: RegistryPackage | null;
}

export interface ParsedRegistry {
  readonly version: string;
  readonly agents: ReadonlyArray<RegistryAgent>;
  /** Agents in the file that were not usable (malformed, bad id or version). */
  readonly skipped: number;
}

const PLATFORM_KEYS: ReadonlyArray<RegistryPlatform> = [
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-aarch64",
  "linux-x86_64",
  "windows-aarch64",
  "windows-x86_64",
];

/** Ids and versions become folder names and command arguments, so they are held to a safe shape. */
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;
const EXACT_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;

export const isSafeCatalogId = (value: string): boolean => SAFE_ID.test(value);
export const isSafeVersion = (value: string): boolean => SAFE_VERSION.test(value);

/**
 * `name@1.2.3` and `@scope/name@1.2.3` only. A range, a dist-tag, a URL, a git
 * address or an alias would let npm fetch something the registry did not pin.
 */
export function parseExactNpmSpec(spec: string): { name: string; version: string } | null {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return null;
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  if (!NPM_NAME.test(name) || !EXACT_VERSION.test(version)) return null;
  return { name, version };
}

function toPackage(value: unknown): RegistryPackage | null {
  const decoded = decodePackage(value);
  if (Option.isNone(decoded)) return null;
  const exact = parseExactNpmSpec(decoded.value.package);
  return {
    spec: decoded.value.package,
    name: exact?.name ?? null,
    version: exact?.version ?? null,
    args: decoded.value.args ?? [],
    env: decoded.value.env ?? {},
  };
}

function toAgent(raw: unknown): RegistryAgent | null {
  const decoded = decodeAgent(raw);
  if (Option.isNone(decoded)) return null;
  const agent = decoded.value;
  if (!SAFE_ID.test(agent.id) || !SAFE_VERSION.test(agent.version) || agent.name.trim() === "") {
    return null;
  }
  const binary: Partial<Record<RegistryPlatform, RegistryBinaryTarget>> = {};
  for (const platform of PLATFORM_KEYS) {
    const target = agent.distribution.binary?.[platform];
    if (target === undefined) continue;
    const decodedTarget = decodeBinaryTarget(target);
    if (Option.isNone(decodedTarget)) continue;
    binary[platform] = {
      archive: decodedTarget.value.archive,
      cmd: decodedTarget.value.cmd,
      sha256: decodedTarget.value.sha256?.toLowerCase() ?? null,
      args: decodedTarget.value.args ?? [],
      env: decodedTarget.value.env ?? {},
    };
  }
  return {
    id: agent.id,
    name: agent.name.trim(),
    version: agent.version,
    description: agent.description?.trim() ?? "",
    repository: agent.repository ?? null,
    website: agent.website ?? null,
    authors: agent.authors ?? [],
    license: agent.license?.trim() || null,
    licenseUrl: agent.license_url ?? null,
    icon: agent.icon ?? null,
    binary,
    npm: agent.distribution.npx === undefined ? null : toPackage(agent.distribution.npx),
    uvx: agent.distribution.uvx === undefined ? null : toPackage(agent.distribution.uvx),
  };
}

/**
 * Decodes a registry document. Returns null when it is not a usable registry
 * (the caller keeps whatever copy it already has). Duplicate ids keep the first.
 */
export function parseRegistry(json: unknown): ParsedRegistry | null {
  const envelope = decodeEnvelope(json);
  if (Option.isNone(envelope)) return null;
  const agents: RegistryAgent[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const raw of envelope.value.agents) {
    const agent = toAgent(raw);
    if (agent === null || seen.has(agent.id)) {
      skipped += 1;
      continue;
    }
    seen.add(agent.id);
    agents.push(agent);
  }
  if (agents.length === 0) return null;
  return { version: envelope.value.version, agents, skipped };
}

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** Parses registry text. Null on malformed JSON or an unusable registry. */
export function parseRegistryText(text: string): ParsedRegistry | null {
  const json = decodeJsonText(text);
  return Option.isSome(json) ? parseRegistry(json.value) : null;
}

/** Lower-case `owner/repo` for a github.com release URL, for the "GitHub release" label. */
export function githubRepoOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return null;
    const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
    return owner && repo ? `${owner}/${repo}` : null;
  } catch {
    return null;
  }
}

/** Archive format from the file name in the URL path. Query and fragment are ignored. */
export type ArchiveFormat = "zip" | "tar.gz" | "raw" | "unsupported";

export function archiveFormatOf(url: string): ArchiveFormat {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return "unsupported";
  }
  if (pathname.endsWith(".zip")) return "zip";
  if (pathname.endsWith(".tar.gz") || pathname.endsWith(".tgz")) return "tar.gz";
  if (
    pathname.endsWith(".tar.bz2") ||
    pathname.endsWith(".tbz2") ||
    pathname.endsWith(".tar") ||
    pathname.endsWith(".dmg") ||
    pathname.endsWith(".pkg") ||
    pathname.endsWith(".deb") ||
    pathname.endsWith(".rpm") ||
    pathname.endsWith(".msi") ||
    pathname.endsWith(".appimage")
  ) {
    return "unsupported";
  }
  // A bare executable: no archive suffix, the file is the program.
  return pathname.endsWith(".exe") || !/\.[a-z0-9]{1,5}$/u.test(pathname) ? "raw" : "unsupported";
}
