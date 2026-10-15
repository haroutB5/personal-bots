/**
 * BotPluginSkillDiagnostics — makes a bot's unloadable plugin skill visible.
 *
 * A plugin skill whose `SKILL.md` cannot be parsed is dropped in silence by
 * every provider: Claude Code and the DeepSeek harness skip the folder, and
 * Codex reports the refusal only inside its own `skills/list` answer, which
 * hbots reads for the owner's roots but not for a bot session. A `SKILL.md`
 * carrying a UTF-8 BOM does exactly that — its frontmatter `---` is no longer
 * at the start of the file, so the YAML parser finds nothing and the skill
 * disappears from the bot (QA, 15 Oct 2026: all four installed
 * `agent-browser/SKILL.md` files carried one).
 *
 * The check below runs where hbots hands a bot's skill folders to a provider
 * (Claude, Codex, the DeepSeek harness) and logs one WARN per unloadable file,
 * naming the bot, the file and the reason. It reads the same folders that
 * provider is given, so a broken skill is never silently invisible.
 *
 * @module provider/BotPluginSkillDiagnostics
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { parseSkillFrontmatter } from "./Drivers/ClaudeSkills.ts";
import { resolvePersonalBotPluginSkillDirs } from "./botPluginSkillRoots.ts";

/** One `SKILL.md` a provider would refuse, and why. */
export interface BotPluginSkillProblem {
  readonly path: string;
  readonly reason: string;
}

/**
 * The `skills/list` message Codex answers for a `SKILL.md` it cannot parse.
 * Kept verbatim so the log matches what Codex itself reports.
 */
export const MISSING_FRONTMATTER_REASON = "missing YAML frontmatter delimited by ---";

/**
 * Why a provider would refuse this `SKILL.md`, or `undefined` when it looks
 * loadable. Covers the two failures a loader hits before anything else: a
 * leading UTF-8 BOM, and frontmatter that is absent or not a YAML mapping.
 */
export const botPluginSkillLoadFailure = (contents: string): string | undefined => {
  if (contents.startsWith("\uFEFF")) {
    return `the file starts with a UTF-8 BOM, so its frontmatter is not recognized (${MISSING_FRONTMATTER_REASON})`;
  }
  switch (parseSkillFrontmatter(contents).kind) {
    case "parsed":
      return undefined;
    case "missing":
      return MISSING_FRONTMATTER_REASON;
    case "malformed":
      return "malformed YAML frontmatter";
  }
};

/**
 * The file as text with its BOM intact. Node's UTF-8 decoder drops a leading
 * BOM (that is the point of one), which would hide exactly the failure this
 * module exists to report, so the bytes are decoded without that special case.
 */
const decodeSkillFile = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

/**
 * Every `SKILL.md` under the given skill folders that a loader would refuse.
 * A skill lives in its own folder (`<root>/<skill>/SKILL.md`) or directly in
 * the root; dot-folders are skipped, as Codex skips them, and a folder without
 * a readable `SKILL.md` is not a skill at all. Unreadable roots and files are
 * left alone: this reports what is broken, it never fails the caller.
 */
export const findUnloadableBotPluginSkills = Effect.fn("findUnloadableBotPluginSkills")(function* (
  skillDirs: ReadonlyArray<string>,
): Effect.fn.Return<
  ReadonlyArray<BotPluginSkillProblem>,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const problems: Array<BotPluginSkillProblem> = [];
  const seen = new Set<string>();

  for (const root of skillDirs) {
    const entries = yield* fileSystem
      .readDirectory(root)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const candidates = [
      path.join(root, "SKILL.md"),
      ...[...entries]
        .filter((entry) => !entry.startsWith("."))
        .sort()
        .map((entry) => path.join(root, entry, "SKILL.md")),
    ];
    for (const candidate of candidates) {
      const skillPath = path.resolve(candidate);
      if (seen.has(skillPath)) continue;
      seen.add(skillPath);
      const bytes = yield* fileSystem
        .readFile(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      // A missing or unreadable file (and a folder named SKILL.md) is not a
      // skill file, so there is nothing to report.
      if (bytes === undefined) continue;
      const reason = botPluginSkillLoadFailure(decodeSkillFile(bytes));
      if (reason !== undefined) problems.push({ path: skillPath, reason });
    }
  }

  return problems;
});

/**
 * Logs one WARN per unloadable `SKILL.md` in the given folders, naming the bot.
 * One line per file, never one per session or per root, so a broken skill is
 * both visible and countable in the server log.
 */
export const logUnloadableBotPluginSkills = Effect.fn("logUnloadableBotPluginSkills")(
  function* (input: {
    readonly botId: string | undefined;
    readonly skillDirs: ReadonlyArray<string>;
  }): Effect.fn.Return<
    ReadonlyArray<BotPluginSkillProblem>,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const problems = yield* findUnloadableBotPluginSkills(input.skillDirs);
    yield* Effect.forEach(
      problems,
      (problem) =>
        Effect.logWarning("bot plugin skill failed to load", {
          botId: input.botId ?? "unknown",
          path: problem.path,
          reason: problem.reason,
        }),
      { discard: true },
    );
    return problems;
  },
);

/**
 * The same check for a personal bot, run where its plugin skill folders are
 * about to be handed to a provider. Resolving the folders here keeps every
 * provider path (Claude, Codex, DeepSeek) on one implementation and one
 * message.
 */
export const logPersonalBotPluginSkillProblems = Effect.fn("logPersonalBotPluginSkillProblems")(
  function* (input: {
    readonly baseDir: string;
    readonly botId: string | undefined;
  }): Effect.fn.Return<
    ReadonlyArray<BotPluginSkillProblem>,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const skillDirs = yield* resolvePersonalBotPluginSkillDirs(input);
    return yield* logUnloadableBotPluginSkills({ botId: input.botId, skillDirs });
  },
);
