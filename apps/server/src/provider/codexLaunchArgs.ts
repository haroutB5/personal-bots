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

// T3 unsubscribes only when it unloads a thread; Codex's own unload delay would stack on that.
export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  "-c",
  "thread_unload_delay_secs=0",
  ...codexLaunchArgv(launchArgs),
];

interface LaunchArgFilter {
  readonly switches: ReadonlySet<string>;
  readonly valueFlags: ReadonlySet<string>;
  readonly inlinePrefixes: ReadonlyArray<string>;
}

const SHARED_VALUE_FLAGS = ["--config", "-c", "--enable", "--disable"];
const SHARED_INLINE_PREFIXES = ["--config=", "-c=", "--enable=", "--disable="];

const MCP_LIST_FILTER: LaunchArgFilter = {
  switches: new Set(),
  valueFlags: new Set([...SHARED_VALUE_FLAGS, "--profile", "-p"]),
  inlinePrefixes: [...SHARED_INLINE_PREFIXES, "--profile=", "-p="],
};

const EXEC_FILTER: LaunchArgFilter = {
  switches: new Set(["--strict-config", "--oss"]),
  valueFlags: new Set([...SHARED_VALUE_FLAGS, "--local-provider", "--profile", "-p"]),
  inlinePrefixes: [...SHARED_INLINE_PREFIXES, "--local-provider=", "--profile=", "-p="],
};

const filterLaunchArgs = (launchArgs: string | undefined, allowed: LaunchArgFilter) => {
  const args = codexLaunchArgv(launchArgs);
  const kept: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (allowed.switches.has(arg)) {
      kept.push(arg);
    } else if (allowed.valueFlags.has(arg)) {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        kept.push(arg, value);
        index++;
      }
    } else if (allowed.inlinePrefixes.some((prefix) => arg.startsWith(prefix))) {
      kept.push(arg);
    }
  }

  return kept;
};

/**
 * Turns off the owner's apps, plugins and Codex memories for a bot. `mcp_servers`
 * cannot be cleared this way because Codex deep-merges `-c` tables.
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
 * Kill switch for a Codex bot's own plugin skills. On (unset) a bot's session
 * names its own and the shared plugin skill folders to Codex; `off` and its
 * aliases restore the previous behaviour, where a personal Codex bot has no
 * skills at all. Read when a bot session starts.
 */
const PERSONAL_BOT_CODEX_SKILLS_ENV = "PERSONAL_BOT_CODEX_SKILLS";
const PERSONAL_BOT_CODEX_SKILLS_OFF = new Set(["off", "0", "false", "no", "disabled"]);

export const personalBotCodexSkillsSwitchOn = (
  environment: NodeJS.ProcessEnv = process.env,
): boolean =>
  !PERSONAL_BOT_CODEX_SKILLS_OFF.has(
    environment[PERSONAL_BOT_CODEX_SKILLS_ENV]?.trim().toLowerCase() ?? "",
  );

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

export const codexExecLaunchArgs = (launchArgs?: string) =>
  filterLaunchArgs(launchArgs, EXEC_FILTER);

export const codexMcpListLaunchArgs = (launchArgs?: string) =>
  filterLaunchArgs(launchArgs, MCP_LIST_FILTER);
