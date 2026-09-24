/**
 * The dedicated "Updates" bot and its event routine, created once by
 * {@link ./PersonalClaudeCodeReview.ts}. Both texts are written to the database
 * at creation and are the user's to edit afterwards (bot settings, and the
 * routine in Tasks > Scheduled); this module is only the starting point.
 *
 * @module personal/claudeCodeReview/reviewPrompts
 */
import {
  PersonalBotId,
  PersonalRoutineId,
  ProviderInstanceId,
  type PersonalBotCreateInput,
  type PersonalRoutineCreateInput,
} from "@t3tools/contracts";

/** Where hbots' source and the notes repo live on this machine. */
export interface ReviewPaths {
  readonly repoDir: string;
  readonly notesDir: string;
}

export const DEFAULT_REVIEW_PATHS: ReviewPaths = {
  repoDir: process.env.PB_REPO_DIR ?? "C:/Claude/AI/personal-bots",
  notesDir: process.env.PB_NOTES_DIR ?? "C:/Claude/AI/personal-bots-notes",
};

export const reportDir = (paths: ReviewPaths) => `${paths.notesDir}/claude-code-updates`;

// Deterministic ids: creation is idempotent on them, so a retried setup never
// duplicates the bot or the routine.
export const UPDATES_BOT_ID = PersonalBotId.make("personal-claude-code-updates");
export const UPDATES_ROUTINE_ID = PersonalRoutineId.make("routine-claude-code-update-review");
export const UPDATES_EVENT_LABEL = "New Claude Code version";

export const updatesBotInstructions = (paths: ReviewPaths) =>
  [
    "You are Updates, Harout's Claude Code update reviewer for hbots: the Bots app you are running in, a t3code fork whose source is at " +
      `${paths.repoDir} (live release branch fix/inline-cards).`,
    "",
    "Your only job: when a new Claude Code or Claude Agent SDK version appears, the app gives you a task with the changelog excerpt. You work out what changed, whether hbots can use it, and whether anything in hbots breaks or should change, and you report.",
    "",
    "Rules:",
    "- Report and propose only. Never edit, commit, push, build, restart or deploy anything in " +
      `${paths.repoDir}, never bump the Agent SDK or change settings, unless Harout explicitly approves a specific proposal in this chat.`,
    `- The one thing you write without asking is the report file in ${reportDir(paths)}/.`,
    "- Number every proposal (P1, P2, ...). Harout approves by replying here, e.g. 'approve P2' or 'approve P1 P3'. On approval, restate exactly what you will change and follow the repo's CLAUDE.md (branch, tests, authored commits) and stop before shipping unless he also says ship.",
    "- Stay in this lane: do not delegate to other bots and do not take on unrelated work; point Harout to the right bot instead.",
    "- Be concise and concrete: file paths, option names, versions. No filler.",
  ].join("\n");

export const updatesBotCreateInput = (paths: ReviewPaths): PersonalBotCreateInput => ({
  botId: UPDATES_BOT_ID,
  name: "Updates",
  title: "Claude Code update reviewer",
  description:
    "Reviews each new Claude Code and Agent SDK release against hbots and proposes what to adopt or fix. Report only.",
  instructions: updatesBotInstructions(paths),
  // Amber like "Sync reports": the maintenance reporters, apart from the dev team's blue.
  avatarShape: "roundedHexagon",
  avatarColor: "#EAB308",
  modelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "medium" }],
  },
  team: "dev",
  lead: false,
  pinned: false,
  memoryAutoSave: true,
});

export const updatesRoutinePrompt = (paths: ReviewPaths) =>
  [
    "A new Claude Code and/or Agent SDK version is out. Review it against hbots. The event data below has the version ranges, the changelog excerpt file and the report path.",
    "",
    "1. Read the changelog excerpt file in full (Claude Code section and Agent SDK section). If it says older releases are condensed, cover the newest ~2 months in depth and summarise the older ones.",
    `2. Read the hbots code each relevant entry could touch, read-only, in ${paths.repoDir}. Start with:`,
    "   - apps/server/src/provider/Layers/ClaudeAdapter.ts (SDK query options, hooks, permission modes, settingSources/strictMcpConfig bot isolation, resume, events)",
    "   - apps/server/src/provider/Drivers/ClaudeDriver.ts, apps/server/src/provider/providerSmokeTest.ts",
    "   - model lists: apps/server/src/provider/ClaudeModelCatalog.ts, ClaudeModelManifest.ts (discovery scans the installed claude.exe)",
    "   - MCP wiring: apps/server/src/mcp/ (toolkits/personal)",
    "   - plugins and skills loaded from bot-plugins (grep for bot-plugins)",
    "   - computer use: apps/server/src/personal/desktop/; memory: apps/server/src/personal/memory/",
    "   - the SDK pin: apps/server/package.json and pnpm-workspace.yaml (@anthropic-ai/claude-agent-sdk)",
    "   Grep for any option, event, env var or setting an entry names before judging it.",
    "3. Write the report (Markdown, aim for under 150 lines) to the report path from the event data, creating the folder if needed:",
    "   # Claude Code <to-version> update review",
    "   One line: ranges covered, installed claude.exe, SDK pinned -> latest.",
    "   ## Recommended actions: numbered proposals P1.. (at most 7), highest value first: what, why, effort S/M/L.",
    "   ## Breaks or needs a change: anything that is or may be broken in hbots now, with the evidence (file:line). Say 'Nothing found' if so.",
    "   ## Relevant changes: one entry per relevant changelog item: what it is (version); can hbots use it; does anything break or need changing; effort S/M/L; recommended action (adopt / adapt / watch / ignore).",
    "   ## Everything else: irrelevant entries summarised in one line per theme (TUI, IDE, gateway, ...).",
    "   ## How to approve: reply here with 'approve P<n>' (several allowed). Nothing changes until you do.",
    "4. Reply in this chat with the same report, so it reaches Harout as a normal notification.",
    "",
    "Report and propose only: do not change hbots code, settings or the SDK pin in this task.",
  ].join("\n");

export const updatesRoutineCreateInput = (paths: ReviewPaths): PersonalRoutineCreateInput => ({
  routineId: UPDATES_ROUTINE_ID,
  botId: UPDATES_BOT_ID,
  title: "Claude Code update review",
  prompt: updatesRoutinePrompt(paths),
  trigger: "event",
  eventLabel: UPDATES_EVENT_LABEL,
  delivery: "model",
});
