/**
 * The dedicated "Updates" bot and its two routines, created once by
 * {@link ./PersonalClaudeCodeReview.ts}:
 * - "Claude Code nightly update": scheduled, every day at 04:00 London. Its
 *   runs are prepared by the server (new releases, proposals carried over) and
 *   the bot reviews, applies what it rates safe, and hands off to the ship
 *   pipeline (scripts/personal/updates/).
 * - "Morning report": an event relay the pipeline posts its report to after
 *   the restart, so the report lands in the Updates chats with no model turn.
 * Both texts are written to the database at creation and are the user's to
 * edit afterwards; this module is only the starting point.
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
/** The proposal ledger (see proposalLedger.ts). */
export const ledgerPath = (paths: ReviewPaths) => `${reportDir(paths)}/proposals.json`;
export const updatesScript = (paths: ReviewPaths, name: string) =>
  `${paths.repoDir}/scripts/personal/updates/${name}`;

// Deterministic ids: creation is idempotent on them, so a retried setup never
// duplicates the bot or a routine.
export const UPDATES_BOT_ID = PersonalBotId.make("personal-claude-code-updates");
/** 1.33.0's event routine; removed by the setup migration to the nightly run. */
export const LEGACY_UPDATES_ROUTINE_ID = PersonalRoutineId.make(
  "routine-claude-code-update-review",
);
export const UPDATES_NIGHTLY_ROUTINE_ID = PersonalRoutineId.make("routine-claude-code-nightly");
export const UPDATES_REPORT_ROUTINE_ID = PersonalRoutineId.make("routine-claude-code-report");

/** When the nightly run happens (Europe/London wall time). */
export const NIGHTLY_TIME = "04:00";
export const NIGHTLY_TIME_ZONE = "Europe/London";
/**
 * A scheduled run that starts after this hour (a laptop that slept through
 * 04:00) is skipped: it would restart Bots while Harout is using it.
 */
export const NIGHTLY_LATEST_START_HOUR = 6;

/** The text 1.33.0 created the bot with; the migration replaces only this exact text. */
export const legacyUpdatesBotInstructions = (paths: ReviewPaths) =>
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

export const LEGACY_UPDATES_BOT_DESCRIPTION =
  "Reviews each new Claude Code and Agent SDK release against hbots and proposes what to adopt or fix. Report only.";

export const UPDATES_BOT_DESCRIPTION =
  "Every night at 04:00 reviews new Claude Code and Agent SDK releases, applies the proposals it rates safe, and posts a morning report. Risky ones wait for 'approve P<n>'.";

const ledgerCommand = (paths: ReviewPaths) => `node "${updatesScript(paths, "ledger.ts")}"`;

export const updatesBotInstructions = (paths: ReviewPaths) =>
  [
    "You are Updates, Harout's Claude Code update engineer for hbots: the Bots app you are running in, a t3code fork whose source is at " +
      `${paths.repoDir} (live release branch fix/inline-cards).`,
    "",
    "Your job: every night at 04:00 (London) the app starts a run. You review any new Claude Code or Claude Agent SDK releases, then implement yourself every open proposal you rate SAFE, and leave the risky ones as proposals for Harout. A deterministic pipeline then runs the gates, builds, deploys, verifies and rolls back if needed, and posts the morning report in your chats.",
    "",
    "Rules:",
    `- Every proposal lives in the ledger ${ledgerPath(paths)} with a global number (P1, P2, ...). Never renumber or reuse one. Use ${ledgerCommand(paths)} to change it; never edit the file by hand.`,
    `- 'approve P<n>' (several allowed, e.g. 'approve P1 P3'): run ${ledgerCommand(paths)} approve P<n> for each and reply that it is queued for the next 04:00 run. 'reject P<n>': ledger reject. Apply an approved proposal right away only if Harout explicitly says now; then follow the repo's CLAUDE.md and stop before shipping unless he also says ship.`,
    `- Outside a nightly run, never edit, commit, push, build, restart or deploy anything in ${paths.repoDir} unless Harout explicitly asks in this chat.`,
    "- Inside a nightly run, follow the run's steps exactly. You never push, build, restart, bump scripts/personal/app-version.txt, touch .env or secrets, reset, force-push, amend or rebase: the pipeline owns shipping.",
    "- Stay in this lane: do not delegate to other bots and do not take on unrelated work; point Harout to the right bot instead.",
    "- Be concise and concrete: file paths, option names, versions. No filler.",
  ].join("\n");

export const updatesBotCreateInput = (paths: ReviewPaths): PersonalBotCreateInput => ({
  botId: UPDATES_BOT_ID,
  name: "Updates",
  title: "Claude Code update engineer",
  description: UPDATES_BOT_DESCRIPTION,
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

/**
 * The nightly run's steps. The server appends the run data (JSON) to this
 * text for every run; the scripts it names do everything that can hurt.
 */
export const updatesNightlyPrompt = (paths: ReviewPaths) =>
  [
    "Nightly Claude Code update run. The run data (JSON) is at the end: the run id and mode, any new releases to review, the proposals to work on, and the exact commands.",
    "",
    "0. Preflight. Run the run data's commands.preflight with a 10 minute command timeout (it takes a few minutes: a database backup, and in a dry run a fresh worktree with vp i). It prints one JSON line. If ok is false, stop here: the pipeline has already reported why. Otherwise use its workDir (where you edit and commit; in a dry run it is a throwaway worktree), its ledger (pass it as --ledger to every ledger command) and its dependencyChangesAllowed. Below, <ledger> means the run data's commands.ledger.",
    "",
    "1. Review, only when the run data has a review. Read the changelog excerpt in full (Claude Code and Agent SDK sections; if older releases are condensed, cover the newest ~2 months in depth and summarise the rest). " +
      `Read the hbots code each relevant entry could touch, read-only (workDir is the same tree as ${paths.repoDir}), starting with:`,
    "   - apps/server/src/provider/Layers/ClaudeAdapter.ts (SDK query options, hooks, permission modes, settingSources/strictMcpConfig bot isolation, resume, events)",
    "   - apps/server/src/provider/Drivers/ClaudeDriver.ts, apps/server/src/provider/providerSmokeTest.ts",
    "   - model lists: apps/server/src/provider/ClaudeModelCatalog.ts, ClaudeModelManifest.ts",
    "   - MCP wiring: apps/server/src/mcp/ (toolkits/personal); plugins and skills from bot-plugins",
    "   - the SDK pin: apps/server/package.json and pnpm-workspace.yaml (@anthropic-ai/claude-agent-sdk)",
    '   Grep for any option, event, env var or setting an entry names before judging it. Register each proposal (at most 7, highest value first) with: <ledger> --ledger <ledger> add --source <review label> --title "<one line>" --detail "<what, why, effort S/M/L, files>". It prints the new id; use those ids in the report. Write the report (Markdown, under 150 lines) to review.reportFile: # Claude Code <version> update review; one line with the ranges, installed claude.exe, SDK pinned -> latest; ## Proposals (id, what, why, effort); ## Breaks or needs a change (with file:line evidence, or \'Nothing found\'); ## Relevant changes (one entry each: version, can hbots use it, breaks anything, effort, adopt/adapt/watch/ignore); ## Everything else (one line per theme).',
    "",
    '2. Decide every actionable proposal (the run data\'s proposals.actionable plus the ones you just added). SAFE means all of: small or medium; no data loss and no destructive or data-altering migration; reversible by a plain git revert; no change to auth, pairing, permissions, secrets or the security model; not a large refactor; you can verify it with tests you can run now; a dependency change (package.json, lockfile, vp i) only when preflight says dependencyChangesAllowed. Anything else, or anything you are not sure you can verify, is RISKY. Record each: <ledger> --ledger <ledger> decide <id> --rating safe|risky --reason "<one line>". An approved proposal is applied whatever you rate it: Harout already decided.',
    "",
    "3. Implement each SAFE or approved proposal, one at a time, in workDir:",
    "   - make the change with focused tests; run them (vp test run <files> in apps/server or apps/web; never a bare vp test run in apps/server) and typecheck the package you touched (tsc --noEmit via ..\\..\\node_modules\\.bin\\tsc.cmd); format the files you touched (vp fmt <files>).",
    '   - one commit per proposal: git -c user.email=harout_b5@live.com -c user.name=haroutB5 commit -m "<conventional title> (P<n>)" -m "Before: ... After: ..."',
    '   - then: <ledger> --ledger <ledger> applied <id> --commits <sha> --notes "Before: ... After: ..."',
    '   - if you cannot make it work, undo only your own uncommitted edits for it (git restore --staged --worktree -- <files>, and delete files you created), then <ledger> --ledger <ledger> failed <id> --reason "<why>". Never leave uncommitted changes behind.',
    "",
    "4. Hand off: run the run data's commands.ship, even if you applied nothing. It returns within seconds; the gates, build, restart, checks and any rollback run detached, and the morning report is posted to your chats after the restart.",
    "",
    "5. Reply in 3 to 6 lines: applied (ids), skipped (ids and why), and that the morning report follows. Do not repeat the review.",
    "",
    "Never push, build, restart, bump the app version, touch .env or secrets, reset, force-push, amend or rebase: the pipeline does the shipping and undoes it if anything is red.",
  ].join("\n");

export const updatesNightlyRoutineCreateInput = (
  paths: ReviewPaths,
): PersonalRoutineCreateInput => ({
  routineId: UPDATES_NIGHTLY_ROUTINE_ID,
  botId: UPDATES_BOT_ID,
  title: "Claude Code nightly update",
  prompt: updatesNightlyPrompt(paths),
  trigger: "schedule",
  schedule: { kind: "daily", time: NIGHTLY_TIME },
  timeZone: NIGHTLY_TIME_ZONE,
  // A slot missed while the laptop slept still runs when it wakes, unless that
  // is past NIGHTLY_LATEST_START_HOUR: the preparer skips it then.
  missedPolicy: "coalesce",
  delivery: "model",
});

export const updatesReportRoutineCreateInput = (): PersonalRoutineCreateInput => ({
  routineId: UPDATES_REPORT_ROUTINE_ID,
  botId: UPDATES_BOT_ID,
  title: "Morning report",
  prompt:
    "Posts the nightly update pipeline's report (the payload's message field) in this bot's chats. No model turn.",
  trigger: "event",
  eventLabel: "Nightly update finished",
  delivery: "relay",
});
