# HANDOFF: hbots 1.64.0 (6 Oct 2026)

Branch `feat/1640` (from `fix/nightly-preflight-1005` 05a392db7d, on live main ba73fba494, live 1.63.0 cafb31f19eba).
Release **da8db6301b18**, staged with `build.ps1 -NoActivate` (4 `.env` keys loaded), not active. Later commits on the branch are
tooling and notes only (scripts/personal/updates, README, this file), which no release carries. Not merged to main.
One additive migration: **099** (`personal_bots.hide_previews INTEGER NOT NULL DEFAULT 0`). Concurrency stays 5.
Evidence: `C:/Users/Ht/.personal-bots/qa/backend-1640/` (scripts, results, screenshots, a-dry/ for the pipeline rehearsal).

## Part A: nightly pipeline (scripts/personal/updates)

- Includes the 05a392db7d preflight fixes (trunk personal-bots/main, code-path comparison, ff-only, build detector).
- The restart now waits for EVERY bot and task (`Wait-PbAllIdle`, same SQL as the idle waiter's `idle-check.mjs`: running chat
  sessions of live threads, tasks queued/running/waiting_for_agent/waiting_for_user/waiting_for_browser/rate_limited; 3 idle
  looks in a row, 20 s apart). Unreadable DB counts as busy. Still busy after `-WaitMinutes` (now 120): nothing is restarted,
  the run is reverted like a failed build (new revert commits, pushed), result `busy`, report "changes reverted (Bots was busy)".
  New `RunResult` "busy" in proposalLedger.ts.
- Found while rehearsing: the lint gate was red on `main` itself (`vp lint` exits 1, 14 errors in 7 files nobody touches), so any
  run with a commit would have been reverted as "gates red: lint". The lint gate is now red only for an error in a file the run
  changed (`Get-UpdatesLintErrorFiles`, `-ChangedPaths`); a lint crash with nothing listed is still red.
- `reviewPrompts.ts`: the Updates bot instructions say live release branch `personal-bots/main`. Setup also replaces an untouched
  copy of the old text (`staleUpdatesBotInstructions`) on the next start; an edited one is left alone. The live Updates bot's stored
  text (read-only check, 6 Oct) already says `personal-bots/main` (edited by hand earlier), so nothing changes for it; the fix matters
  for a newly created Updates bot. The 1.33.0 legacy text keeps `fix/inline-cards` on purpose: setup matches it byte for byte.
- Tests: `updates.tests.ps1` 105 checks (real SQLite + real node check: busy, waiting_for_user, deleted-chat session, unreadable,
  timeout, streak restart; lint gate with a real process), `proposalLedger.test.ts`, `PersonalClaudeCodeReview.test.ts`.
- Rehearsal (real `nightly-pipeline.ps1 -Mode DryRun` against the live base with one recorded commit, throwaway idle DB with a
  running task of another bot): gates green, built f6c33a0544db, waited 00:02:08 to 00:03:19 while the other bot's task ran,
  proceeded after 3 idle looks, deploy and rollback rehearsals exit 0, rehearsal release and worktree removed. Log:
  `qa/backend-1640/a-dry/run/pipeline.log`.

## Part B: Claude Agent SDK 0.3.282 -> 0.3.289

- `apps/server/package.json` ^0.3.289, lockfile at 0.3.289, the `minimumReleaseAgeExclude` entry for 0.3.282 removed (0.3.289 passes
  the age rule on its own). Message unions unchanged; `satisfies never` guard compiles.
- Approval-required threads send `permissionMode: "default"` explicitly (`runtimeModeToPermission`); bots (full-access) unchanged.
- `system/init` `plugin_errors` become a `runtime.warning` work-log row ("A plugin did not load: <plugin> (<type>): <message>") and a
  server WARN `claude.plugin.load-errors` (plugin and type only).
- Not built (Harout declined): steer with priority now, get_task_output.

## Part C: Hide message previews (per bot, off by default)

Toggle "Hide message previews" in the bot form (BotForm), stored in `personal_bots.hide_previews`, exposed as
`PersonalBot.hidePreviews`, set through `personalBots.update`. With it on, outside the chat itself:
Covered:

- Bots list row (`personalBots.list`): the server sends no text and no context for the bot's newest message (`hidden: true`); the row
  shows "Preview hidden", or "Working" while it works (progress notes are not requested for it). Task-turn and notice labels are hidden too
  (they carry task titles).
- Cold-start snapshot (localStorage `t3code:chats-snapshot:v3`): preview "Preview hidden", thread title not stored.
- Group rows (`personalGroups.list`): a group whose newest message is a bot's, with a hidden bot among its members, sends no text.
- Push (web push body, outbox row `payload_json`) and in-app banner: body "Open to read it." for every kind that can carry bot text
  (notify_user line, task title, failure reason, team-change line); no reply preview on the banner. Title keeps the bot name.
- Delegation cards in another bot's chat: the hidden child's steps and result/error text. Memory screen: task summaries of that bot.
- Notifications screen copy no longer claims pushes never carry message text.
  Left out, on purpose:
- Pinned strip, the bot's own chat list (BotThreadsScreen), Team screen, Tasks list: they show no reply text (status words, avatars, titles).
  Chat titles and task titles are not reply text and are unchanged.
- Task detail screen (result, work record): it is the place to read that bot's result, like the chat.
- Computer/browser help requests (the reason is a request the owner has to act on); group chat screen and vote cards (inside a chat).
- Memory notes and rules (what was chosen to be kept, not reply text). Lead bots cannot change the switch (not in their tools).
- The server database still holds all text (it is the source); only previews, caches and notifications are scrubbed.

## Gates (exit codes)

server `vp test run src/personal src/mcp` 0 (153 files, 1984 tests); web `vp test run --project unit src/features/personal` 0 (175 files,
1767 tests); tsc 0 errors in contracts, shared, client-runtime, server, web; `updates.tests.ps1` 0; `vp lint` exits 1 on `main` too
(pre-existing errors in 7 untouched files, none in a file this branch changed); fmt check clean on changed files.
Real checks: `qa/backend-1640/c1-result.json`, `c2-result.json`, `c3-result.json` (Part C, fake CLI, 390 px dark and light, shots/),
`b1-*.json`, `b2-result.json` (Part B, real CLI, Haiku 4.5).
