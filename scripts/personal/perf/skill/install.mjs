// Installs the skills in this folder for every hbots bot:
//   <baseDir>/bot-plugins/_shared/.claude/skills/<skill>/
// with the shared plugin manifest the server looks for
// (apps/server/src/provider/Layers/ClaudeAdapter.ts, PERSONAL_BOT_SHARED_PLUGIN).
// Covers the dev and prod data roots that exist. Re-run after editing a skill;
// new sessions pick it up (running sessions keep what they loaded).
//
//   node scripts/personal/perf/skill/install.mjs
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const skills = NodeFS.readdirSync(here, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() && NodeFS.existsSync(NodePath.join(here, entry.name, "SKILL.md")),
  )
  .map((entry) => entry.name);
const MANIFEST = {
  name: "hbots-shared",
  version: "1.0.0",
  description: "Skills every hbots bot loads (installed from scripts/personal/perf/skill).",
  skills: "./.claude/skills/",
};

for (const root of ["dev", "prod"]) {
  const baseDir = NodePath.join(NodeOS.homedir(), ".personal-bots", root);
  if (!NodeFS.existsSync(baseDir)) continue;
  const shared = NodePath.join(baseDir, "bot-plugins", "_shared");
  NodeFS.mkdirSync(NodePath.join(shared, ".claude-plugin"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(shared, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(MANIFEST, null, 2)}\n`,
  );
  for (const skill of skills) {
    const target = NodePath.join(shared, ".claude", "skills", skill);
    NodeFS.rmSync(target, { recursive: true, force: true });
    NodeFS.cpSync(NodePath.join(here, skill), target, { recursive: true });
    console.log(`installed ${skill} -> ${target}`);
  }
}
