/**
 * Mise-managed providers.
 *
 * A provider installed by mise lives under
 * `<data>/mise/installs/<dir>/<version>/…`, or behind a shim at
 * `<data>/mise/shims/<name>`. Its version is moved by `mise install
 * <tool>@latest`, which repoints the `latest` alias and keeps the previous
 * version on disk for a rollback. Installing an older version does not move
 * that alias, so the rollback installs it and then points the alias back. The
 * latest version must come from `mise latest <tool>`, never npm: npm publishes
 * a release before mise's registry has it, and trusting npm makes the app
 * update to a version mise cannot install.
 *
 * @module personal/providerUpdates/miseProviderMaintenance
 */
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";

const MISE_LATEST_TIMEOUT_MS = 15_000;
const MISE_LATEST_MAX_BYTES = 4_096;
const MISE_WHICH_MAX_BYTES = 4_096;
const BACKEND_FILE_MAX_BYTES = 4_096;

export interface MiseOwnership {
  readonly toolSpec: string;
  readonly misePath: string;
  readonly installDir: string;
}

const slashPath = (value: string) => value.replaceAll("\\", "/");

export function miseInstallDirFromCommandPath(commandPath: string): string | null {
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

export function miseShimName(commandPath: string): string | null {
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
export function parseMiseToolSpec(backendFile: string): string | null {
  const match = /^\s*short\s*=\s*"([^"]+)"\s*$/m.exec(backendFile);
  const toolSpec = match?.[1]?.trim();
  return toolSpec !== undefined && toolSpec.length > 0 ? toolSpec : null;
}

function runMise(
  misePath: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  maxBytes: number,
) {
  return Effect.gen(function* () {
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
}

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
  const misePath = yield* resolveCommandPath("mise", { env: context.env }).pipe(
    Effect.catchTags({ CommandResolutionError: () => Effect.succeed(null) }),
  );
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
