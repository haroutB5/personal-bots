/** The dsh runtime half: pinned install paths, launch file, deny plugin, and
 * the ACP runtime one dsh chat drives. Nothing spawns at import time.
 * @module provider-deepseek/server/dshRuntime */
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { botProtectedPaths } from "@t3tools/provider-core/server/botProtectedPaths";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

import type { DeepSeekSettings } from "../settings.ts";
import { DSH_PINNED_VERSION, DSH_RUNTIME_DIR_NAME } from "./engine.ts";
import { DSH_DENY_PLUGIN_FILE, type DshDenyPluginInput } from "./dshSupport.ts";

export interface DshRuntime {
  readonly runtimeDir: string;
  /** The dsh entry point, run with hbots' own `node`. */
  readonly binJs: string;
  readonly version: string;
}

/** `~/.personal-bots/runtimes/dsh-0.2.1-rc.3` — never inside a release folder. */
export const defaultDshRuntimeDir = (): string =>
  [NodeOS.homedir(), ".personal-bots", "runtimes", DSH_RUNTIME_DIR_NAME].join("/");

/**
 * The installed dsh runtime: the instance's own path when it names one, else
 * the pinned per-machine install. Nothing is probed here; the provider status
 * check runs `--version` against `binJs`.
 */
export const resolveDshRuntime = Effect.fn("resolveDshRuntime")(function* (
  settings: Pick<DeepSeekSettings, "dshRuntimePath">,
): Effect.fn.Return<DshRuntime, never, Path.Path> {
  const path = yield* Path.Path;
  const configured = settings.dshRuntimePath.trim();
  const runtimeDir = path.resolve(
    configured.length > 0 ? expandHomePath(configured, NodeOS.homedir()) : defaultDshRuntimeDir(),
  );
  return {
    runtimeDir,
    binJs: path.join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    version: DSH_PINNED_VERSION,
  };
});

/** What the provider card says when the runtime is not installed or is another build. */
export const DSH_RUNTIME_MISSING_MESSAGE =
  "DeepSeek Harness runtime missing: run scripts/personal/install-dsh";

/** The bot plugin folders under `<baseDir>/bot-plugins`. */
const PERSONAL_BOT_PLUGINS_DIR = "bot-plugins";
const PERSONAL_BOT_SHARED_PLUGIN = "_shared";
const PERSONAL_BOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const PLUGIN_MANIFEST_PATH = [".claude-plugin", "plugin.json"] as const;

const readPluginManifestSkillsField = (text: string): string | undefined => {
  if (text.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const skills = (parsed as Record<string, unknown>)["skills"];
  if (typeof skills !== "string") return undefined;
  const trimmed = skills.trim();
  if (trimmed.length === 0) return undefined;
  // A plugin manifest is data on disk. An absolute path, or one climbing out
  // of the plugin folder, would widen a bot's skill roots beyond its own.
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[A-Za-z]:/.test(trimmed)) {
    return undefined;
  }
  return trimmed.split(/[\\/]/).includes("..") ? undefined : trimmed;
};

/**
 * The skill folders a launch names: the shared plugin, the bot's own, and
 * the workspace's `.claude/skills` and `.agents/skills` when present.
 * `includeDefaultRoots: false` keeps the owner's `~/.agents/skills` out.
 */
export const resolveDshSkillDirs = Effect.fn("resolveDshSkillDirs")(function* (input: {
  readonly baseDir: string;
  readonly botId: string | undefined;
  readonly cwd: string;
}): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pluginsRoot = path.join(input.baseDir, PERSONAL_BOT_PLUGINS_DIR);
  const pluginDirs = [
    path.join(pluginsRoot, PERSONAL_BOT_SHARED_PLUGIN),
    ...(input.botId !== undefined && PERSONAL_BOT_ID_PATTERN.test(input.botId)
      ? [path.join(pluginsRoot, input.botId)]
      : []),
  ];
  const dirs: string[] = [];
  for (const pluginDir of pluginDirs) {
    const manifestPath = path.join(pluginDir, ...PLUGIN_MANIFEST_PATH);
    const exists = yield* fileSystem.exists(manifestPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) continue;
    const text = yield* fileSystem
      .readFileString(manifestPath)
      .pipe(Effect.orElseSucceed(() => ""));
    const skills = readPluginManifestSkillsField(text);
    if (skills === undefined) continue;
    const dir = path.resolve(pluginDir, skills);
    const hasDir = yield* fileSystem.exists(dir).pipe(Effect.orElseSucceed(() => false));
    if (hasDir) dirs.push(dir);
  }
  for (const relative of [".claude/skills", ".agents/skills"]) {
    const dir = path.resolve(input.cwd, relative);
    const hasDir = yield* fileSystem.exists(dir).pipe(Effect.orElseSucceed(() => false));
    if (hasDir) dirs.push(dir);
  }
  return dirs;
});

/**
 * The deny plugin a launch loads: secrets read-write denied, the database and
 * its sidecars write-denied, and the dsh home write-denied. dsh has no
 * `permissions.deny` of its own, so this restores Claude's tool-level guard.
 */
export const resolveDshDenyPlugin = Effect.fn("resolveDshDenyPlugin")(function* (input: {
  readonly runtimeDir: string;
  readonly paths: {
    readonly secretsDir: string;
    readonly dbPath: string;
  };
  readonly dshHome: string;
  readonly enabled: boolean;
}): Effect.fn.Return<DshDenyPluginInput | undefined, never, Path.Path> {
  if (!input.enabled) return undefined;
  const path = yield* Path.Path;
  const pluginPath = path.join(input.runtimeDir, DSH_DENY_PLUGIN_FILE);
  const url = yield* path
    .toFileUrl(pluginPath)
    .pipe(Effect.orElseSucceed(() => ({ href: pluginPath }) as URL));
  const protectedPaths = botProtectedPaths({
    stateDir: input.dshHome,
    dbPath: input.paths.dbPath,
    secretsDir: input.paths.secretsDir,
    logsDir: input.dshHome,
  });
  return {
    pluginUrl: url.href,
    denyReadWrite: protectedPaths
      .filter((entry) => entry.access === "read-write")
      .map((entry) => entry.path),
    denyWrite: [
      ...protectedPaths.filter((entry) => entry.kind === "file").map((entry) => entry.path),
      input.dshHome,
    ],
  };
});

/** Writes the patch next to the harness home. Its content is never logged. */
export const writeDshLaunchPatch = Effect.fn("writeDshLaunchPatch")(function* (input: {
  readonly dshHome: string;
  readonly threadId: string;
  readonly patch: string;
}): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(input.dshHome, "launch");
  const file = path.join(directory, `${input.threadId}.json`);
  yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(Effect.ignore);
  yield* fileSystem.writeFileString(file, input.patch).pipe(Effect.ignore);
  return file;
});

/** Removes a session's patch once its process has stopped. */
export const removeDshLaunchPatch = Effect.fn("removeDshLaunchPatch")(function* (input: {
  readonly dshHome: string;
  readonly threadId: string;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem
    .remove(path.join(input.dshHome, "launch", `${input.threadId}.json`), { force: true })
    .pipe(Effect.ignore);
});

/**
 * Removes launch patches left behind by a session that never got to delete
 * its own (a crash, or the server being killed). They hold bot instructions,
 * not secrets, but a stale one describes a chat that is gone.
 */
export const sweepDshLaunchDir = Effect.fn("sweepDshLaunchDir")(function* (input: {
  readonly dshHome: string;
}): Effect.fn.Return<number, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(input.dshHome, "launch");
  const entries = yield* fileSystem
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const removedThis = yield* fileSystem.remove(path.join(directory, entry), { force: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (removedThis) removed += 1;
  }
  return removed;
});

export interface DshAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "cancelBehavior" | "clientCapabilities" | "clientInfo" | "resumeMethod"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}

/**
 * The ACP runtime for one dsh chat: `resume` (dsh has no `session/load`),
 * cancel waits for the prompt response, and both client capabilities stay off
 * because dsh reads and writes the workspace itself.
 */
export const makeDshAcpRuntime = Effect.fn("makeDshAcpRuntime")(function* (
  input: DshAcpRuntimeInput,
) {
  const { childProcessSpawner, ...runtimeOptions } = input;
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...runtimeOptions,
      clientInfo: { name: "t3-code", version: "0.0.0" },
      // dsh answers `authenticate` with an immediate success whatever the
      // method id, so the id only has to be present.
      authMethodId: "none",
      resumeMethod: "resume",
      cancelBehavior: "wait-for-prompt",
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }).pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
    ),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});
