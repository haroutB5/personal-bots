/**
 * Bot sessions get an empty XDG_CONFIG_HOME, drop outside config, and a v2
 * `shell create.before` plugin that restores the owner's XDG folders.
 * @module provider/opencodeBotIsolation
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const PERSONAL_BOT_OPENCODE_ENVIRONMENT = {
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_SHARE: "1",
} as const;

/** The owner's own XDG values ("" when unset), read back by the plugin below. */
const OWNER_XDG = ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"] as const;

const PLUGIN_DIRECTORY_SEGMENTS = ["opencode", "plugins", "restore-owner-env"] as const;
const LEGACY_PLUGIN_FILE_SEGMENTS = ["opencode", "plugin", "t3-restore-owner-env.js"] as const;

/**
 * Runs in the bot's OpenCode 2 server before every shell command it spawns.
 * An empty value reads as unset for git, gh, mise and Node's xdg-basedir.
 */
export const PERSONAL_BOT_OPENCODE_ENV_PLUGIN = `// Written by T3 Code for personal-bot OpenCode sessions. Do not edit.
import { Plugin } from "@opencode/plugin";

export function restoreOwnerEnvironment(event) {
  for (const name of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    const value = process.env["HBOTS_OWNER_" + name];
    event.env[name] = value || "";
    event.env["HBOTS_OWNER_" + name] = "";
  }
}

export default Plugin.define({
  id: "hbots.restore-owner-environment",
  async setup(ctx) {
    await ctx.shell.hook("create.before", restoreOwnerEnvironment);
  },
});
`;

/** Local OpenCode 2 plugin package: `exports` names the server part. */
const PERSONAL_BOT_OPENCODE_ENV_PLUGIN_PACKAGE =
  '{"name":"hbots-restore-owner-env","type":"module","exports":"./index.js"}\n';

/**
 * Per-session config layered over the empty bots home. `small_model` pins
 * OpenCode's own side calls (titles, compaction) to the bot's model so they
 * never land on a default the owner did not pick. `plugins` loads the
 * owner-environment hook from the bots home, which v2 needs explicitly.
 */
export function personalBotOpenCodeConfigContent(input: {
  readonly model?: string | undefined;
  readonly pluginDirectory: string;
}): string {
  const model = input.model?.trim();
  return JSON.stringify({
    share: "disabled",
    autoupdate: false,
    ...(model && model.includes("/") ? { small_model: model } : {}),
    plugins: [input.pluginDirectory],
  });
}

/** The bot session's server environment: `base` (with its secrets) plus the isolation. */
export function personalBotOpenCodeEnvironment(input: {
  readonly base: NodeJS.ProcessEnv;
  readonly configHome: string;
  readonly pluginDirectory: string;
  readonly model?: string | undefined;
}): NodeJS.ProcessEnv {
  return {
    ...input.base,
    ...PERSONAL_BOT_OPENCODE_ENVIRONMENT,
    XDG_CONFIG_HOME: input.configHome,
    ...Object.fromEntries(OWNER_XDG.map((name) => [`HBOTS_OWNER_${name}`, input.base[name] ?? ""])),
    OPENCODE_CONFIG_CONTENT: personalBotOpenCodeConfigContent({
      model: input.model,
      pluginDirectory: input.pluginDirectory,
    }),
  };
}

export interface PersonalBotOpenCodeHome {
  /** The bots' `XDG_CONFIG_HOME`, never the owner's. */
  readonly configHome: string;
  /** The v2 plugin directory listed in `plugins`. */
  readonly pluginDirectory: string;
}

/**
 * Creates `<stateDir>/opencode-bots` with its v2 env plugin and package.json
 * (rewritten only when the content drifted) and returns their paths.
 */
export const ensurePersonalBotOpenCodeHome = Effect.fn("ensurePersonalBotOpenCodeHome")(function* (
  stateDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configHome = path.join(stateDir, "opencode-bots");
  const pluginDirectory = path.join(configHome, ...PLUGIN_DIRECTORY_SEGMENTS);
  yield* fileSystem.makeDirectory(pluginDirectory, { recursive: true });
  // OpenCode 2 never reads the 1.x `opencode/plugin` file, so drop it.
  yield* fileSystem
    .remove(path.join(configHome, ...LEGACY_PLUGIN_FILE_SEGMENTS))
    .pipe(Effect.ignore);

  const pluginPath = path.join(pluginDirectory, "index.js");
  const currentPlugin = yield* fileSystem
    .readFileString(pluginPath)
    .pipe(Effect.orElseSucceed(() => ""));
  if (currentPlugin !== PERSONAL_BOT_OPENCODE_ENV_PLUGIN) {
    yield* fileSystem.writeFileString(pluginPath, PERSONAL_BOT_OPENCODE_ENV_PLUGIN);
  }

  const packagePath = path.join(pluginDirectory, "package.json");
  const currentPackage = yield* fileSystem
    .readFileString(packagePath)
    .pipe(Effect.orElseSucceed(() => ""));
  if (currentPackage !== PERSONAL_BOT_OPENCODE_ENV_PLUGIN_PACKAGE) {
    yield* fileSystem.writeFileString(packagePath, PERSONAL_BOT_OPENCODE_ENV_PLUGIN_PACKAGE);
  }

  return { configHome, pluginDirectory } satisfies PersonalBotOpenCodeHome;
});
