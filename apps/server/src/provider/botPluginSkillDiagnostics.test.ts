// @effect-diagnostics preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import {
  MISSING_FRONTMATTER_REASON,
  findUnloadableBotPluginSkills,
  logPersonalBotPluginSkillProblems,
  logUnloadableBotPluginSkills,
} from "./botPluginSkillDiagnostics.ts";

const BOM = "\uFEFF";
const GOOD_SKILL = "---\nname: good\ndescription: A good skill.\n---\n\nBody.\n";
const BOM_SKILL = `${BOM}---\nname: bom\ndescription: Refused by every parser.\n---\n\nBody.\n`;

interface CapturedLine {
  readonly level: string;
  readonly text: string;
  readonly fields: Record<string, unknown>;
}

/** Every log line with its structured fields, so a test can count and name them. */
const captureLogLines = () => {
  const lines: Array<CapturedLine> = [];
  const sink = Logger.make<unknown, void>(({ logLevel, message }) => {
    const [text, fields] = Array.isArray(message) ? message : [message, {}];
    lines.push({
      level: logLevel,
      text: String(text),
      fields: (fields ?? {}) as Record<string, unknown>,
    });
  });
  return { lines, layer: Logger.layer([sink], { mergeWithExisting: false }) };
};

const writeSkill = (root: string, relativePath: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(root, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

it.layer(NodeServices.layer)("botPluginSkillDiagnostics", (it) => {
  it.effect("finds the SKILL.md files a provider would refuse, and only those", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-bot-skills-" });

      yield* writeSkill(root, "good/SKILL.md", GOOD_SKILL);
      // Claude Code accepts CRLF frontmatter; it must never be a false positive.
      yield* writeSkill(root, "crlf/SKILL.md", GOOD_SKILL.replace(/\n/g, "\r\n"));
      yield* writeSkill(root, "bom/SKILL.md", BOM_SKILL);
      yield* writeSkill(root, "no-frontmatter/SKILL.md", "# Just a heading\n");
      yield* writeSkill(root, "malformed/SKILL.md", "---\nname: [unclosed\n---\n\nBody.\n");
      // A folder without a SKILL.md is not a skill; dot-folders are skipped.
      yield* writeSkill(root, "no-skill/README.md", "not a skill");
      yield* writeSkill(root, ".hidden/SKILL.md", BOM_SKILL);

      const problems = yield* findUnloadableBotPluginSkills([root]);

      expect(
        problems.map((problem) => [path.relative(root, problem.path), problem.reason]),
      ).toEqual([
        [path.join("bom", "SKILL.md"), expect.stringContaining("UTF-8 BOM")],
        [path.join("malformed", "SKILL.md"), "malformed YAML frontmatter"],
        [path.join("no-frontmatter", "SKILL.md"), MISSING_FRONTMATTER_REASON],
      ]);
      // The same words Codex puts in `skills/list.errors`.
      expect(MISSING_FRONTMATTER_REASON).toBe("missing YAML frontmatter delimited by ---");
    }),
  );

  it.effect("reads the SKILL.md that sits directly in a skill folder", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-bot-skill-root-" });
      yield* writeSkill(root, "SKILL.md", BOM_SKILL);

      const problems = yield* findUnloadableBotPluginSkills([root]);

      expect(problems).toHaveLength(1);
      expect(problems[0]?.reason).toContain("UTF-8 BOM");
    }),
  );

  it.effect("logs one WARN per broken file, naming the bot, the file and the reason", () => {
    const logs = captureLogLines();
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-bot-skills-warn-" });
      yield* writeSkill(root, "good/SKILL.md", GOOD_SKILL);
      yield* writeSkill(root, "bom/SKILL.md", BOM_SKILL);
      yield* writeSkill(root, "no-frontmatter/SKILL.md", "# Just a heading\n");

      const problems = yield* logUnloadableBotPluginSkills({
        botId: "bot-one",
        skillDirs: [root],
      });

      expect(problems).toHaveLength(2);
      expect(logs.lines).toHaveLength(2);
      expect(logs.lines[0]).toMatchObject({
        level: "Warn",
        text: "bot plugin skill failed to load",
        fields: {
          botId: "bot-one",
          path: path.join(root, "bom", "SKILL.md"),
          reason: expect.stringContaining("UTF-8 BOM"),
        },
      });
      expect(logs.lines[1]).toMatchObject({
        level: "Warn",
        fields: {
          botId: "bot-one",
          path: path.join(root, "no-frontmatter", "SKILL.md"),
          reason: MISSING_FRONTMATTER_REASON,
        },
      });
    }).pipe(Effect.provide(logs.layer));
  });

  it.effect("logs nothing for a bot whose skills all load", () => {
    const logs = captureLogLines();
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-bot-skills-good-" });
      yield* writeSkill(root, "good/SKILL.md", GOOD_SKILL);

      const problems = yield* logUnloadableBotPluginSkills({
        botId: "bot-one",
        skillDirs: [root],
      });

      expect(problems).toEqual([]);
      expect(logs.lines).toEqual([]);
    }).pipe(Effect.provide(logs.layer));
  });

  it.effect("checks the shared and the bot's own plugin folders, naming that bot", () => {
    const logs = captureLogLines();
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-bot-plugins-" });
      // Both plugins declare their skills folder in the manifest, as hbots
      // installs them, and the shared one is healthy.
      for (const plugin of ["_shared", "bot-one"]) {
        yield* fileSystem.makeDirectory(
          path.join(baseDir, "bot-plugins", plugin, ".claude-plugin"),
          { recursive: true },
        );
        yield* fileSystem.writeFileString(
          path.join(baseDir, "bot-plugins", plugin, ".claude-plugin", "plugin.json"),
          JSON.stringify({ name: plugin, skills: "./.claude/skills/" }),
        );
      }
      yield* writeSkill(
        baseDir,
        path.join("bot-plugins", "_shared", ".claude", "skills", "good", "SKILL.md"),
        GOOD_SKILL,
      );
      yield* writeSkill(
        baseDir,
        path.join("bot-plugins", "bot-one", ".claude", "skills", "bom", "SKILL.md"),
        BOM_SKILL,
      );

      const problems = yield* logPersonalBotPluginSkillProblems({ baseDir, botId: "bot-one" });

      expect(problems).toHaveLength(1);
      expect(logs.lines).toHaveLength(1);
      expect(logs.lines[0]).toMatchObject({
        level: "Warn",
        text: "bot plugin skill failed to load",
        fields: {
          botId: "bot-one",
          path: path.join(
            baseDir,
            "bot-plugins",
            "bot-one",
            ".claude",
            "skills",
            "bom",
            "SKILL.md",
          ),
          reason: expect.stringContaining("UTF-8 BOM"),
        },
      });
    }).pipe(Effect.provide(logs.layer));
  });
});
