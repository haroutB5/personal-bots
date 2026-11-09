/**
 * A bot's OpenCode session gets its own XDG_CONFIG_HOME with no owner MCP
 * servers, agents or plugins, flags that drop outside config, and a shell.env
 * plugin that gives its shell commands the owner's own XDG value back.
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

/** The owner's own `XDG_CONFIG_HOME` ("" when unset), read back by the plugin below. */
const OWNER_XDG_CONFIG_HOME_ENV = "T3_OWNER_XDG_CONFIG_HOME";

const PLUGIN_FILE_SEGMENTS = ["opencode", "plugin", "t3-restore-owner-env.js"] as const;

/**
 * Runs in the bot's OpenCode server before every shell command it spawns.
 * An empty value reads as unset for git, gh and Node's xdg-basedir.
 */
export const PERSONAL_BOT_OPENCODE_ENV_PLUGIN = `// Written by T3 Code for personal-bot OpenCode sessions. Do not edit.
export const T3RestoreOwnerEnv = async () => ({
  "shell.env": async (_input, output) => {
    output.env.XDG_CONFIG_HOME = process.env.${OWNER_XDG_CONFIG_HOME_ENV} ?? "";
  },
});
`;

/**
 * Per-session config layered over the empty bots home. `small_model` pins
 * OpenCode's own side calls (titles, compaction) to the bot's model so they
 * never land on a default the owner did not pick.
 */
export function personalBotOpenCodeConfigContent(input: {
  readonly model?: string | undefined;
}): string {
  const model = input.model?.trim();
  return JSON.stringify({
    share: "disabled",
    autoupdate: false,
    ...(model && model.includes("/") ? { small_model: model } : {}),
  });
}

/** The bot session's server environment: `base` (with its secrets) plus the isolation. */
export function personalBotOpenCodeEnvironment(input: {
  readonly base: NodeJS.ProcessEnv;
  readonly configHome: string;
  readonly model?: string | undefined;
}): NodeJS.ProcessEnv {
  return {
    ...input.base,
    ...PERSONAL_BOT_OPENCODE_ENVIRONMENT,
    XDG_CONFIG_HOME: input.configHome,
    [OWNER_XDG_CONFIG_HOME_ENV]: input.base.XDG_CONFIG_HOME ?? "",
    OPENCODE_CONFIG_CONTENT: personalBotOpenCodeConfigContent({ model: input.model }),
  };
}

/**
 * Creates `<stateDir>/opencode-bots` with its env plugin (rewritten only when
 * the content drifted) and returns it, the bots' `XDG_CONFIG_HOME`.
 */
export const ensurePersonalBotOpenCodeHome = Effect.fn("ensurePersonalBotOpenCodeHome")(function* (
  stateDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = path.join(stateDir, "opencode-bots");
  const pluginPath = path.join(home, ...PLUGIN_FILE_SEGMENTS);
  yield* fileSystem.makeDirectory(path.dirname(pluginPath), { recursive: true });
  const current = yield* fileSystem.readFileString(pluginPath).pipe(Effect.orElseSucceed(() => ""));
  if (current !== PERSONAL_BOT_OPENCODE_ENV_PLUGIN) {
    yield* fileSystem.writeFileString(pluginPath, PERSONAL_BOT_OPENCODE_ENV_PLUGIN);
  }
  return home;
});
