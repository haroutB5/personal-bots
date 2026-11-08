/**
 * Mise-owned providers: ownership, installable latest and installed versions.
 * A rollback must uninstall newer versions because any mise install rebuilds
 * the aliases to the highest version on disk.
 */
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { collectUint8StreamText } from "./collectStreamText.ts";

const MISE_LATEST_TIMEOUT_MS = 15_000;
const MISE_LATEST_MAX_BYTES = 4_096;
const MISE_WHICH_MAX_BYTES = 4_096;

export interface MiseOwnership {
  readonly toolSpec: string;
  readonly misePath: string;
  readonly installDir: string;
}

const slashPath = (value: string) => value.replaceAll("\\", "/");

function miseInstallDirFromCommandPath(commandPath: string): string | null {
  const normalized = slashPath(commandPath);
  // npm globals under mise's Node live at .../mise/installs/node/<ver>/lib/node_modules/.
  // npm owns those, not mise.
  if (normalized.toLowerCase().includes("/lib/node_modules/")) return null;
  const marker = "/mise/installs/";
  const markerIndex = normalized.toLowerCase().lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const directory = normalized.slice(markerIndex + marker.length).split("/")[0];
  if (!directory) return null;
  return `${normalized.slice(0, markerIndex + marker.length)}${directory}`;
}

function miseShimName(commandPath: string): string | null {
  const normalized = slashPath(commandPath);
  const marker = "/mise/shims/";
  const markerIndex = normalized.toLowerCase().lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const name = normalized.slice(markerIndex + marker.length);
  if (name.length === 0 || name.includes("/")) return null;
  return name.replace(/\.exe$/i, "");
}

/**
 * Reads the tool spec mise wrote beside the version directories. This is the
 * authoritative name: the directory for an npm backend is `npm-…`, while the
 * install command needs `npm:@scope/name`.
 */
function parseMiseToolSpec(backendFile: string): string | null {
  const match = /^\s*short\s*=\s*"([^"]+)"\s*$/m.exec(backendFile);
  const toolSpec = match?.[1]?.trim();
  return toolSpec !== undefined && toolSpec.length > 0 ? toolSpec : null;
}

const runMise = Effect.fn("runMise")(function* (
  misePath: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  maxBytes: number,
) {
  return yield* Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(ChildProcess.make(misePath, args, { env, extendEnv: true }));
    yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
    const [stdout, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes }),
        child.exitCode,
        Stream.runDrain(child.stderr),
      ],
      { concurrency: "unbounded" },
    );
    return Number(exitCode) === 0 && !stdout.truncated ? stdout.text.trim() : null;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(MISE_LATEST_TIMEOUT_MS)),
    Effect.map((result) => Option.getOrElse(result, () => null)),
    Effect.catchCause(() => Effect.succeed(null)),
  );
});

/**
 * Finds the mise command that owns this provider, or null when the executable
 * is not mise's. A shim is followed through `mise which` because its real path
 * is the mise binary itself, not the tool.
 */
export const resolveMiseOwnership = Effect.fn("resolveMiseOwnership")(function* (context: {
  readonly resolvedCommandPath: string;
  readonly realCommandPath: string;
  readonly env: NodeJS.ProcessEnv;
}) {
  const misePath = yield* resolveCommandPath("mise", { env: context.env });
  if (!misePath) return null;

  const fileSystem = yield* FileSystem.FileSystem;
  const readToolSpec = Effect.fn("readMiseToolSpec")(function* (installDir: string) {
    const text = yield* fileSystem
      .readFileString(`${installDir}/.mise.backend.toml`)
      .pipe(Effect.orElseSucceed(() => ""));
    return parseMiseToolSpec(text);
  });

  const installDir =
    miseInstallDirFromCommandPath(context.realCommandPath) ??
    miseInstallDirFromCommandPath(context.resolvedCommandPath);
  if (installDir) {
    const toolSpec = yield* readToolSpec(installDir);
    if (toolSpec) return { toolSpec, misePath, installDir } satisfies MiseOwnership;
  }

  const shim = miseShimName(context.resolvedCommandPath);
  if (!shim) return null;
  const resolvedByMise = yield* runMise(
    misePath,
    ["which", shim],
    context.env,
    MISE_WHICH_MAX_BYTES,
  );
  const resolvedDir = resolvedByMise ? miseInstallDirFromCommandPath(resolvedByMise) : null;
  if (!resolvedDir) return null;
  const toolSpec = yield* readToolSpec(resolvedDir);
  return toolSpec
    ? ({ toolSpec, misePath, installDir: resolvedDir } satisfies MiseOwnership)
    : null;
});

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

export function isStableMiseVersion(value: string): boolean {
  return STABLE_VERSION.test(value);
}

/** Numeric order for `x.y.z` install directories; mise only writes stable versions. */
function compareMiseVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Every stable version installed under a mise tool directory, oldest first. */
export const listMiseInstalledVersions = Effect.fn("listMiseInstalledVersions")(function* (
  installDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const entries = yield* fileSystem
    .readDirectory(installDir)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  return entries.filter(isStableMiseVersion).sort(compareMiseVersions);
});

/**
 * The rollback set. Every stable version above the good one must go: mise
 * rebuilds `latest`, the major and the minor alias to the highest installed
 * version after any install, so a leftover newer release wins the next time
 * any tool is installed.
 */
export function miseVersionsNewerThan(
  versions: ReadonlyArray<string>,
  floor: string,
): ReadonlyArray<string> {
  if (!isStableMiseVersion(floor)) return [];
  return [...new Set(versions)]
    .filter((version) => isStableMiseVersion(version) && compareMiseVersions(version, floor) > 0)
    .sort(compareMiseVersions);
}

export function miseInstallDirFromLatestPath(latestPath: string): string | null {
  const normalized = slashPath(latestPath);
  return normalized.endsWith("/latest") ? normalized.slice(0, -"/latest".length) : null;
}

/** What `mise install <tool>@latest` can actually deliver, or null. */
export const resolveMiseLatestVersion = Effect.fn("resolveMiseLatestVersion")(function* (
  ownership: MiseOwnership,
  env: NodeJS.ProcessEnv,
) {
  const output = yield* runMise(
    ownership.misePath,
    ["latest", ownership.toolSpec],
    env,
    MISE_LATEST_MAX_BYTES,
  );
  const latest = output
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .findLast((line) => line.length > 0);
  return latest ?? null;
});
