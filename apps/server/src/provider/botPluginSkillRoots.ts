import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** The bot plugin folders under `<baseDir>/bot-plugins`. */
export const PERSONAL_BOT_PLUGINS_DIR = "bot-plugins";
export const PERSONAL_BOT_SHARED_PLUGIN = "_shared";
export const PERSONAL_BOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

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

const declaredPluginSkillsDir = Effect.fn("botPluginSkillRoots.declaredPluginSkillsDir")(function* (
  pluginDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(pluginDir, ...PLUGIN_MANIFEST_PATH);
  const exists = yield* fileSystem.exists(manifestPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return undefined;
  const text = yield* fileSystem.readFileString(manifestPath).pipe(Effect.orElseSucceed(() => ""));
  const skills = readPluginManifestSkillsField(text);
  return skills === undefined ? undefined : path.resolve(pluginDir, skills);
});

/**
 * The skill folders a bot's plugins keep: the shared folder, then the bot's own.
 * A manifest names the folder, falling back to `.claude/skills`; an unsafe bot
 * id gets the shared folder alone, so a bot never reaches another bot's skills.
 */
export const resolvePersonalBotPluginSkillDirs = Effect.fn("resolvePersonalBotPluginSkillDirs")(
  function* (input: {
    readonly baseDir: string;
    readonly botId: string | undefined;
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
    const dirs: Array<string> = [];
    for (const pluginDir of pluginDirs) {
      const declared = yield* declaredPluginSkillsDir(pluginDir);
      const candidates =
        declared === undefined ? [path.join(pluginDir, ".claude", "skills")] : [declared];
      for (const candidate of candidates) {
        const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
        if (!exists) continue;
        dirs.push(path.resolve(candidate));
        break;
      }
    }
    return dirs;
  },
);
