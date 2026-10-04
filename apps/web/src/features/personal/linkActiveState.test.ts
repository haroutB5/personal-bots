// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

/**
 * TanStack Router marks a Link active (data-status="active", aria-current="page")
 * whenever its path is a prefix of the location, so a Back arrow to /bots, or a
 * link to /bots/<id>, announced itself as the current page on every chat of the
 * bot (1.60.30). A Link to a parent page needs activeOptions={{ exact: true }}.
 */
const PARENT_PATHS = new Set([
  '"/bots"',
  '"/bots/$botId"',
  '"/bots/settings"',
  '"/tasks"',
  '"/tasks/routines/$routineId"',
]);

/** Files whose links to those paths are deliberate or are not parents of the screen they sit on. */
const LEFT_ALONE: Readonly<Record<string, string>> = {
  "PersonalTabBar.tsx": "the real nav tabs: their active state is intended and styled",
  "TasksScreen.tsx": "the filter tabs set aria-current from the selected view on purpose",
  "ChatsScreen.tsx": "the Settings gear sits on /bots, which is a parent of it, not the reverse",
  "ConversationRoutinesPanel.tsx": "/tasks from a chat: not a parent of the chat route",
  "PersonalSettingsScreen.tsx": "/tasks from /bots/settings: not a parent",
  "TeamConstellationCard.tsx": "/bots/<id> from /bots/team: not a parent",
  "TeamMembersSheet.tsx": "/bots/<id> from /bots/team: not a parent",
  "TokenUsageSection.tsx": "/bots/<id> from /bots/team: not a parent",
};

/** The `<Link ...>` opening tags of a source file, found by balancing braces and quotes. */
function linkTags(source: string): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(/<Link(?=[\s/>])/g)) {
    let depth = 0;
    let quote: string | null = null;
    for (let at = match.index!; at < source.length; at++) {
      const char = source[at]!;
      if (quote !== null) {
        if (char === quote) quote = null;
      } else if (char === "/" && source[at + 1] === "/" && depth === 0) {
        at = source.indexOf("\n", at); // a comment between a tag's attributes
        if (at === -1) break;
      } else if (char === '"' && depth === 0) {
        quote = char;
      } else if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
      } else if (char === ">" && depth === 0 && source[at - 1] !== "=") {
        tags.push(source.slice(match.index!, at + 1));
        break;
      }
    }
  }
  return tags;
}

it("every Link to a parent page opts out of the router's prefix-active state", () => {
  const dir = import.meta.dirname;
  const offenders: string[] = [];
  let checked = 0;
  for (const file of NodeFS.readdirSync(dir)) {
    if (!file.endsWith(".tsx") || file.includes(".test.") || file in LEFT_ALONE) continue;
    for (const tag of linkTags(NodeFS.readFileSync(NodePath.join(dir, file), "utf8"))) {
      const to = /\bto=(\{[^}]*\}|"[^"]*")/.exec(tag)?.[1] ?? "";
      const parent = PARENT_PATHS.has(to) || to.startsWith("{backTarget");
      if (!parent) continue;
      checked++;
      if (!tag.includes("activeOptions")) offenders.push(`${file}: ${to}`);
    }
  }
  expect(checked).toBeGreaterThan(15);
  expect(offenders).toEqual([]);
});
