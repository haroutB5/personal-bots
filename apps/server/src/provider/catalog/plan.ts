/**
 * Which distribution of a registry agent this machine installs, or why none.
 * The catalogue lists support from this, and the installer runs the same plan,
 * so a row that says "Install" can always be installed.
 *
 * Order for one platform: a binary archive whose fingerprint is known (the
 * registry's sha256, or one the overlay pinned), then an exact-version npm
 * package, then an unverified binary (not installable in v1), then uv.
 *
 * @module provider/catalog/plan
 */
import type { ProviderCatalogUnsupportedReason } from "@t3tools/contracts";

import type { CatalogOverlayEntry } from "./overlay.ts";
import {
  archiveFormatOf,
  type ArchiveFormat,
  type RegistryAgent,
  type RegistryBinaryTarget,
  type RegistryPlatform,
} from "./registry.ts";

/** Reasons the catalogue shows. The first three are the design's; the rest are found in the registry data. */
export type UnsupportedReason =
  | ProviderCatalogUnsupportedReason
  | "noChecksum"
  | "unpinnedVersion"
  | "unsupportedArchive"
  | "badDistribution";

export interface BinaryInstallPlan {
  readonly kind: "binary";
  readonly url: string;
  readonly host: string;
  readonly format: Exclude<ArchiveFormat, "unsupported">;
  readonly sha256: string;
  /** Where the fingerprint came from. */
  readonly sha256Source: "registry" | "overlay";
  /** Launch command relative to the unpacked folder, forward slashes. */
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly version: string;
}

export interface NpmInstallPlan {
  readonly kind: "npm";
  readonly name: string;
  readonly version: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export type InstallPlan =
  | BinaryInstallPlan
  | NpmInstallPlan
  | { readonly kind: "unsupported"; readonly reason: UnsupportedReason };

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/iu;

/** Characters Windows forbids in a file name, plus control characters. */
function hasReservedCharacter(segment: string): boolean {
  for (const character of segment) {
    if (character.charCodeAt(0) < 0x20 || '<>:"|?*'.includes(character)) return true;
  }
  return false;
}

/**
 * A launch command from the registry as a safe path inside the unpacked folder.
 * The registry writes Windows paths with either slash (`./dist-package\cursor-agent.cmd`).
 * Returns null for anything that could leave the folder or name a device.
 */
export function normalizeRelativeCommand(command: string): string | null {
  if (command.includes("\0") || command.length > 400) return null;
  if (/^[A-Za-z]:/u.test(command) || command.startsWith("/") || command.startsWith("\\"))
    return null;
  const segments: string[] = [];
  for (const segment of command.split(/[\\/]/u)) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." || hasReservedCharacter(segment) || WINDOWS_RESERVED.test(segment)) {
      return null;
    }
    if (segment.endsWith(".") || segment.endsWith(" ")) return null;
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join("/");
}

/** Variables a registry entry may never set: they change how every program starts. */
const BLOCKED_ENV =
  /^(?:PATH|PATHEXT|NODE_OPTIONS|NODE_PATH|COMSPEC|SYSTEMROOT|WINDIR|LD_.*|DYLD_.*|npm_config_.*)$/iu;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

/** Environment from the registry, minus names that are unsafe or malformed. */
export function safeRegistryEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name) || BLOCKED_ENV.test(name)) continue;
    if (value.length > 1_000 || value.includes("\0")) continue;
    out[name] = value;
  }
  return out;
}

/** Arguments from the registry; an argument with a NUL or a huge one drops the whole list's safety, so the list is refused. */
export function safeRegistryArgs(args: ReadonlyArray<string>): string[] | null {
  if (args.length > 32) return null;
  for (const arg of args) {
    if (arg.length > 500 || arg.includes("\0")) return null;
  }
  return [...args];
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
      ? parsed.hostname
      : null;
  } catch {
    return null;
  }
}

function fingerprintFor(
  agent: RegistryAgent,
  platform: RegistryPlatform,
  target: RegistryBinaryTarget,
  overlay: CatalogOverlayEntry | undefined,
): { readonly sha256: string; readonly source: "registry" | "overlay" } | null {
  if (target.sha256 !== null) return { sha256: target.sha256, source: "registry" };
  const pinned = overlay?.sha256Pins?.[agent.version]?.[platform];
  return pinned === undefined ? null : { sha256: pinned.toLowerCase(), source: "overlay" };
}

export interface PlanOptions {
  readonly platform: RegistryPlatform | null;
  /** False when no Node.js is on this machine, so npm agents cannot run. */
  readonly nodeAvailable?: boolean;
  readonly overlay?: CatalogOverlayEntry | undefined;
}

/** Decides what installing `agent` on this machine means. */
export function resolveInstallPlan(agent: RegistryAgent, options: PlanOptions): InstallPlan {
  const target = options.platform === null ? undefined : agent.binary[options.platform];
  const fingerprint =
    target === undefined || options.platform === null
      ? null
      : fingerprintFor(agent, options.platform, target, options.overlay);

  if (target !== undefined && fingerprint !== null) {
    const format = archiveFormatOf(target.archive);
    const host = hostOf(target.archive);
    const command = normalizeRelativeCommand(target.cmd);
    const args = safeRegistryArgs(target.args);
    if (host === null || command === null || args === null) {
      return { kind: "unsupported", reason: "badDistribution" };
    }
    if (format === "unsupported") return { kind: "unsupported", reason: "unsupportedArchive" };
    return {
      kind: "binary",
      url: target.archive,
      host,
      format,
      sha256: fingerprint.sha256,
      sha256Source: fingerprint.source,
      command,
      args,
      env: safeRegistryEnv(target.env),
      version: agent.version,
    };
  }

  const npm = agent.npm;
  if (npm !== null) {
    if (npm.name !== null && npm.version !== null) {
      const args = safeRegistryArgs(npm.args);
      if (args === null) return { kind: "unsupported", reason: "badDistribution" };
      if (options.nodeAvailable === false) return { kind: "unsupported", reason: "needsNode" };
      return {
        kind: "npm",
        name: npm.name,
        version: npm.version,
        args,
        env: safeRegistryEnv(npm.env),
      };
    }
    // An npm entry without an exact version cannot be pinned; fall through only
    // when nothing else installs, so the reason names what is wrong.
    if (target === undefined && agent.uvx === null) {
      return { kind: "unsupported", reason: "unpinnedVersion" };
    }
  }

  if (target !== undefined) return { kind: "unsupported", reason: "noChecksum" };
  if (agent.uvx !== null) return { kind: "unsupported", reason: "needsUv" };
  return { kind: "unsupported", reason: "noWindowsBuild" };
}

/** Free space needed is this many times the download: the archive, its unpacked copy, and slack. */
export const DISK_SAFETY_FACTOR = 2.5;
/** When a binary's size is unknown, ask for room for a large agent. */
export const UNKNOWN_BINARY_REQUIRED_BYTES = 1536 * 1024 * 1024;
/** An npm tree is not sized before npm resolves it; ask for room for a big one (Gemini CLI unpacks to about 100 MB). */
export const NPM_REQUIRED_BYTES = 600 * 1024 * 1024;

/** Free bytes an install of `plan` needs before it starts. `downloadBytes` is the HEAD size, when known. */
export function requiredFreeBytes(
  plan: BinaryInstallPlan | NpmInstallPlan,
  downloadBytes: number | null,
): number {
  if (plan.kind === "npm") return NPM_REQUIRED_BYTES;
  return downloadBytes === null
    ? UNKNOWN_BINARY_REQUIRED_BYTES
    : Math.ceil(downloadBytes * DISK_SAFETY_FACTOR);
}
