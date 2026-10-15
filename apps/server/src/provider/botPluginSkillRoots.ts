import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  PERSONAL_BOT_ID_PATTERN,
  PERSONAL_BOT_PLUGINS_DIR,
  PERSONAL_BOT_SHARED_PLUGIN,
} from "./Layers/ClaudeAdapter.ts";

/** Where a bot's own plugin folder keeps its manifest. */
export const PLUGIN_MANIFEST_PATH = [".claude-plugin", "plugin.json"] as const;

/** The `skills` path a plugin manifest names, when it is a usable relative path. */
export const readPluginManifestSkillsField = (text: string): string | undefined => {
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

/** The folder a plugin manifest declares for its skills, when it declares one. */
const declaredPluginSkillsDir = (
  pluginDir: string,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifestPath = path.join(pluginDir, ...PLUGIN_MANIFEST_PATH);
    const exists = yield* fileSystem.exists(manifestPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return undefined;
    const text = yield* fileSystem
      .readFileString(manifestPath)
      .pipe(Effect.orElseSucceed(() => ""));
    const skills = readPluginManifestSkillsField(text);
    return skills === undefined ? undefined : path.resolve(pluginDir, skills);
  });

/**
 * The skill folders a bot's own plugins keep their skills in: the shared
 * folder every bot loads (`<baseDir>/bot-plugins/_shared/`), then the bot's own
 * (`<baseDir>/bot-plugins/<botId>/`). A plugin names the folder in its
 * manifest; one that names nothing usable falls back to `.claude/skills`,
 * where hbots installs them. Only folders that exist are named, and an unknown
 * or unsafe bot id gets the shared folder alone, so a bot never reaches
 * another bot's skills.
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
