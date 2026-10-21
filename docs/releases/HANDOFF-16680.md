# hbots 1.66.80

Risk tier: medium. It changes how much context bots carry and how memory is resent, and adds migration 112 (an additive table), so the release runner takes the pre-migration backup. No credentials touched. `PERSONAL_TASKS_CONCURRENCY` stays 5.

Branch `feat/hbots-16677`, on top of live 1.66.79 notes commit `89d713739c`, with `perf/hbots-16680-context` (Optimizer) and `fix/hbots-16680-usage-memory` (Backend) merged.

## Why

The 21 Oct spend audit (`dev-team/reviews/token-spend-audit-2026-10-21/REPORT.md`, reviewed by Fable) found that most usage is bots re-reading long contexts. Harout approved items 2 to 7 ("Do 2 to 7"). Items 3 (Designer on Sonnet, one-week trial) and 6 (a new chat per routine run, for the crypto alerts, the crypto briefing and Scout's RAM monitor) were settings, done on 21 Oct. This release carries the code items.

## Changes

- **Task chats compact by themselves.** Delegated-task and routine chats compact automatically: Claude with a 200k window (Claude Code 2.1.304 compacts at about 167k) and Codex at 150k tokens. Harout's own chats stay manual, including a task continued into his chat with `continueChatId`. DeepSeek dsh already compacts at 786k and is unchanged. Kill switch `PERSONAL_TASK_AUTO_COMPACT=off`.
  - Audit estimate: Claude -1.30B tokens a week, Codex -32%.
- **Long command output is capped at about 12k characters.**
  - Claude: `bashOutputMaxChars` 12000 (Bash and PowerShell). A longer result comes back as a preview plus a file path, which the bot reads only if it needs the rest. The CLI default was 30000.
  - Codex: `tool_output_token_limit` 3000 tokens, which applies to every Codex tool output, browser snapshots included.
  - Kill switch: `PERSONAL_BOT_SHELL_OUTPUT_CAP=off`, or a number of characters.
- **Opus bots' general-purpose subagents run on Sonnet 5.5** (`CLAUDE_CODE_SUBAGENT_MODEL`). Explore stays on Haiku, Plan stays on the bot's own model, and no bot's main model changes. Kill switch `PERSONAL_SUBAGENT_MODEL=off`, or another model id.
- **Token usage counts Antigravity once.** Each call had been counted three times: generation usage, step usage and a retry copy. Live 7-day figure: 21,628 records / 2.933B tokens → 7,218 / 0.980B. Kill switch `PERSONAL_ANTIGRAVITY_USAGE_DEDUPE=off`.
- **Token usage keeps a chat's earlier sessions on its bot.** Migration 112, `provider_session_history`, remembers every session a chat resumes, and the usage reader includes them. The write is best-effort and never fails a turn. The 577M tokens already orphaned stay as "other", because they can't be recovered. Kill switch `PERSONAL_TOKEN_USAGE_SESSION_HISTORY=off`.
- **Memory is resent as changes only.**
  - When a session already has the list, only changes are sent: added rules, edited rules (as the new text) and the ids of forgotten or replaced rules.
  - Notes go once a session, and again after a compaction, a new session or the 20-turn full refresh.
  - Fixed on the way: compaction was only detected in chats that had preferences.

## Proof

- Optimizer, `C:/Users/Ht/.personal-bots/qa/hbots-16680-ctx/RESULT.md`:
  - Real CLIs: the 167k threshold; a 20k-character result cut to a 2,252-character preview; the subagent ran on Sonnet; Codex truncated a long output, and a Codex turn fell from 28,037 to 11,087 tokens.
  - Throwaway server: a task chat compacted from 167K to 12K tokens and completed; the owner chat on the same bot did not compact; all three switches off showed no change.
- Backend:
  - server tsc 0 and 498 tests passed;
  - the live 7-day numbers above were read read-only.

## Risks

- A compaction summary can lose detail on a long task.
- QA on Codex may see long browser snapshots cut short; setting the cap switch to 40000 brings back about Codex's usual limit.
- Claude bots need an extra Read call to see shell output beyond 12k characters.
