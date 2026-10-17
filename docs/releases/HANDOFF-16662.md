# HANDOFF 1.66.62

Six context-budget trims on top of the live 1.66.61, from Fable's review of 17 Oct. A fresh Claude
bot chat cost 33-38k tokens before the bot did anything: about 18k of tool schemas, 4.9k of system
prompt, 4k of environment and skills list, and 5-6k of memory block. This release cuts the tools
list, the bundled skills list, the whole-file `Read` that pulled 54k chars in on turn one, the
`search_memory` result that once put 21.7k chars into a fresh chat, and the size and re-send
cadence of the memory block. Staged only (nothing is activated).

Branch `release/hbots-16662`, built from the live notes commit `03c3b288d1` (`personal-bots/main`);
the code commits are `5dac500e05` (the six trims) and `61bb9e14a9` (the `search_memory` result
schema). No migration: the maximum stays 111.
`PERSONAL_TASKS_CONCURRENCY` stays 5. Nothing about compaction changed: no `autoCompactWindow` was
set and no compaction behaviour was touched.

1. **`search_memory` results are capped** (`apps/server/src/mcp/toolkits/personal/handlers.ts`,
   `apps/server/src/personal/memory/memoryShared.ts`, Backend) - the returned entries are whole
   entries whose JSON fits about 6,000 characters, best matches first, with the app-scoped rules a
   query names counted against the cap, and a closing `N more entries matched; narrow the query or
lower limit.` line. The first match is always returned, so a single oversized entry cannot blank
   the result. Kill switch `PERSONAL_MEMORY_SEARCH_MAX_CHARS` takes a character count, or `off` to
   return every match again. The `note` key is declared on `SearchMemoryResult` (`tools.ts`): the
   toolkit encodes a handler's return through that schema, so an undeclared key is dropped before
   the model sees it, and the tool's advertised output schema carries it too.
2. **A whole-file `Read` of a large text file is refused**
   (`apps/server/src/provider/Layers/ClaudeAdapter.ts`,
   `apps/server/src/personal/personalContextBudget.ts`, Backend) - a `Read` with no `offset` and no
   `limit` on a text file over 20,000 characters comes back as
   `... is 225,737 chars; grep first, then Read with offset/limit, or pass allow_large: true if you
need it all.` Images, PDFs and notebooks are exempt, as is every other tool. Kill switch
   `PERSONAL_READ_LARGE_GUARD=off`. It rides a `PreToolUse` hook because a personal bot session
   runs `bypassPermissions`, where the SDK never calls `canUseTool`.
3. **The four built-in tools no bot calls are denied**
   (`apps/server/src/provider/Layers/ClaudeAdapter.ts`, Backend) - `Workflow`, `ReportFindings`,
   `ScheduleWakeup` and `AskUserQuestion` took 0 calls each in the last 150 Claude transcripts
   (`Agent` took 5 and `PowerShell` 1,042, so both stay). They are passed in the SDK's
   `disallowedTools`, which removes them from the model's tool schemas. Kill switch
   `PERSONAL_BOT_TOOL_TRIM=off`.
4. **The bundled skills bots never call leave the model's skills list**
   (`apps/server/src/provider/Layers/ClaudeAdapter.ts`, Backend) - `keybindings-help`, `init`,
   `plugin-authoring`, `code-review`, `simplify`, `loop`, `schedule` and
   `fewer-permission-prompts` are set to `user-invocable-only` in `settings.skillOverrides`, so
   they leave the list the model reads while `/name` still works. Kill switch
   `PERSONAL_BOT_SKILL_TRIM=off`. The `statusline-setup` entry in the review's list is a bundled
   _agent type_, not a skill, and `skillOverrides` does not touch agents.
5. **The shared `speedoptimiser` description is two lines** (`scripts/personal/perf/skill/speedoptimiser/SKILL.md`,
   Backend) - 579 -> 309 characters, the rest of the method is unchanged inside the skill body. The
   shared plugin lives in the data root, so `node scripts/personal/perf/skill/install.mjs` must run
   once for live bots to see it.
6. **The memory block is smaller and re-sent less often**
   (`apps/server/src/personal/memory/memoryShared.ts`, `memoryBlock.ts`,
   `apps/server/src/mcp/toolkits/personal/tools.ts`, Backend) - `BLOCK_ENTRY_MAX_CHARS` 500 -> 300
   and the full preference list every 20 turns instead of 12. **Preferences are never clipped**: the
   cap already applied to notes and task summaries only, and it still does, so no rule can lose its
   wording. The one-line "still apply unchanged" reminder carries the rules in the turns between.

## 1. Measured effect

Captured on the real installed CLI 2.1.302, pointed at a local mock API with a dummy key
(`dev-team/qa/hbots-16662-context-budget/`, `mock_api.py` + `driver.mjs`); nothing was sent and no
tokens were spent. Both runs used the same prompt, plugin folder and options, and differed only by
the trims.

| Measure        | before                 | after                  | saved  |
| -------------- | ---------------------- | ---------------------- | ------ |
| request body   | 67,310 chars           | 52,647 chars           | 14,663 |
| tool schemas   | 22 tools, 53,130 chars | 19 tools, 40,351 chars | 12,779 |
| system message | 9,121 chars            | 6,898 chars            | 2,223  |
| skills segment | 4,598 chars, 9 skills  | 2,712 chars, 4 skills  | 1,886  |

An OAuth subscription session is offered more bundled skills than an API-key session, so that run
understates the live saving. The same deltas on Fable's real subscription capture
(`research/_ctxbudget/capture_body.json`, 27 tools, 15 skills) are 86,539 -> 74,030 chars of tool
schemas and 7,366 -> 4,372 chars of skills list: **about 15,500 characters saved on every step**,
roughly 4,400 tokens at 3.5 chars per token.

The guard, against the real CLI:

| Read call                            | Result                                                   |
| ------------------------------------ | -------------------------------------------------------- |
| `{file_path}` on a 225,737-char file | denied, `is_error=true`, the 180-char refusal above      |
| `{file_path, offset: 1, limit: 40}`  | allowed, 1,467 chars                                     |
| `{file_path, allow_large: true}`     | allowed, entire file (the built-in Read tool accepts it) |

`ClaudeAdapter.botDeny.test.ts` proves what the CLI is told: `--disallowedTools=` with the four
names, `skillOverrides` for the eight skills in the `--settings` JSON, and a `PreToolUse` hook with
matcher `Read` in the `initialize` request, all only for a bot session.

`memoryHandlers.test.ts` proves the cap at the tool boundary: 40 matching preferences come back as
an encoded result of at most 6,000 characters, holding the leading matches in order and the
"N more entries matched; narrow the query or lower limit." line, and with
`PERSONAL_MEMORY_SEARCH_MAX_CHARS=off` all 40 come back with no note.

## 2. What was left out and why

- The eight bundled skills are hidden with `user-invocable-only`, not `off`, so `/code-review`,
  `/simplify` and the workflow skills still run if a bot or a command asks for one; nothing breaks
  hard because the `Workflow` tool is gone. The app's own code review does not use the bundled
  skill.
- `disableBundledSkills` exists in the same settings object but hides the skills bots do use
  (`dataviz`, `claude-api`, `update-config`), so it is not used.
- Codex, OpenCode and the DeepSeek `dsh` engine get nothing here: the bundled tool list and the
  skills list are Claude Code CLI features. The DeepSeek **Claude Code engine** is
  `ClaudeAdapter` underneath, so it gets all of it.
- The 1b cap and 3b/3c limits are code constants with no kill switch of their own beyond the
  `search_memory` cap's env var; the memory ones were fixed values before this release too.

## 3. For QA

Focus on: a bot turn that calls `search_memory` with a broad query (result at or under 6,000 chars,
best matches first, the "more entries matched" line when it is capped); a bot asked to read a large
source file whole (refusal message, then `offset`/`limit`, then `allow_large: true`); a bot chat's
first step (the tools `Workflow`, `ReportFindings`, `ScheduleWakeup` gone and the skills list
shorter); and one turn after 20 turns in the same chat to see the full preference list come back.
The `speedoptimiser` description only changes after `node scripts/personal/perf/skill/install.mjs`.

Left running: nothing. The capture harness lives outside the repo in
`C:/Claude/AI/dev-team/qa/hbots-16662-context-budget/` and its mock servers were stopped by their
captured PIDs.
