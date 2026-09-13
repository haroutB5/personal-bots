import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};

/**
 * Codex features a personal bot's app-server never gets: ChatGPT connectors
 * (`apps`), the owner's installed plugins and the MCP servers they bundle
 * (`plugins`), and Codex's own cross-session memories (`memories`); bots use
 * the app's memory tools instead. Feature flags are plain booleans, so the
 * override replaces them. `mcp_servers` from the owner's config.toml cannot be
 * cleared this way: Codex deep-merges `-c` tables, so an empty table is a no-op.
 */
export const PERSONAL_BOT_CODEX_APP_SERVER_ARGS: ReadonlyArray<string> = [
  "-c",
  "features.apps=false",
  "-c",
  "features.plugins=false",
  "-c",
  "features.memories=false",
];

/**
 * Turns off the owner's own Codex skills (`~/.codex/skills`, `~/.agents/skills`)
 * for a personal bot. Codex has no switch for user-scoped skills, but it
 * honours `skills.config` entries keyed by each skill's full `SKILL.md` path.
 * JSON string escaping is valid TOML basic-string escaping.
 */
export const personalBotCodexSkillArgs = (
  skillFiles: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  skillFiles.length === 0
    ? []
    : [
        "-c",
        `skills.config=[${skillFiles
          .map((path) => `{path=${JSON.stringify(path)},enabled=false}`)
          .join(",")}]`,
      ];

/**
 * `SKILL.md` files under the given skill roots, skipping dot-folders (Codex's
 * bundled `.system` skills are part of Codex, not the owner's add-ons). A
 * missing or unreadable root lists nothing.
 */
export const listOwnerCodexSkillFiles = Effect.fn("listOwnerCodexSkillFiles")(function* (
  roots: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<string> = [];
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root, { recursive: true })
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entry of entries) {
      const segments = entry.split(/[\\/]/);
      if (segments.at(-1) !== "SKILL.md") continue;
      if (segments.some((segment) => segment.startsWith("."))) continue;
      files.push(path.join(root, entry));
    }
  }
  return files.toSorted();
});

export const codexSessionAppServerArgs = (
  appServerArgs: ReadonlyArray<string> | undefined,
  launchArgs: string | undefined,
) => {
  const launchAppServerArgs = codexAppServerArgs(launchArgs);
  return appServerArgs ? [...launchAppServerArgs, ...appServerArgs] : launchAppServerArgs;
};
