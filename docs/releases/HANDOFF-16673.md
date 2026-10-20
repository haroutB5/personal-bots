# HANDOFF 1.66.73

Bots can run on Antigravity (Gemini 4 Argon, Gemini 3.8 Flash). Built by CTO
as a hotfix. No migration (the maximum stays 111);
`PERSONAL_TASKS_CONCURRENCY` stays 5.

Branch `hotfix/hbots-16673-antigravity-bots`, cut from `personal-bots/main`
`713302bea5` (live 1.66.72 `1aeb673228da`). Code commit `fd26160e3f`.

## 1. Antigravity in the bot form

Harout, 20 Oct: "I need the gemini models in bots asap. Currently i cant
chose any". Antigravity was signed in on live (Google AI Pro, models Gemini 4
Argon low/medium/high and Gemini 3.8 Flash) but the bot form never offered
it: it only lists providers whose adapter passes the bot's persona
(`BOT_INSTRUCTION_DRIVER_KINDS`, checked against the adapter sources by
`botInstructionCoverage`), and the Antigravity adapter appended only the
runtime notes to each prompt.

- `AntigravityAdapter.sendTurn` now sends
  `withBotInstructions(buildRuntimeInstructions(...), input.systemInstructions)`
  in the text block it already adds to every prompt. Every turn carries the
  bot's name, instructions and app rules, so an edit takes effect on the next
  turn. The t3-code MCP server was already passed to Antigravity sessions.
- `antigravity` joins `BOT_INSTRUCTION_DRIVER_KINDS`; the bot form's
  "no provider" copy names it.
- Follow-up (not this release): Antigravity 1.4.0 advertises
  `_meta.antigravity.systemPrompt.append` at initialize; moving the persona
  there would stop repeating it in every prompt. Not used yet because the
  request format could not be verified tonight (the laptop was out of memory
  and the probe never got past startup).

## 2. Tests

Staged release `a29c15d18b48`; gate evidence below PASS (all six gates,
e2e 12/12). The first server-tests run exited 1 with 0 failed tests: the
vitest worker for the unrelated `machineImportProvisioning.test.ts` timed out
starting while the laptop had under 1 GB free; rerun alone through
`heavy-job.ps1`: 2941 passed in 213 files. A second rerun (ps-tests) only
re-recorded the evidence on a clean tree; the final evidence is one full clean run of all six gates (below).

Targeted: `AntigravityAdapter.test.ts` 31 passed, including the new "sends the
bot's persona with every prompt" (the runtime-notes block ends with
`<bot_instructions>...</bot_instructions>`); `botInstructionCoverage.test.ts`
4 passed (the source scan now finds the Antigravity call site);
`botFormModel`/`BotForm` 51 passed (Antigravity selectable, Cursor and Grok
still not).

Not tested before ship: a live Antigravity bot turn (needs the release; CTO
checks it live by creating a bot on Gemini and asking its name). Small
contained change: builder proof, no QA run (handbook tiers).

## 3. Risks

- The persona is part of every prompt's text, so long bot instructions cost
  input tokens on every Antigravity turn (counted against Harout's Google AI
  Pro quota).
- Adapter change is one text block; other drivers unchanged.

## Gate evidence

<!-- gate-evidence:begin sha=a29c15d18b481a82c9e6f5d55a3731a233b1786c release=a29c15d18b48 json-sha256=18ff14a453bc6c8ddd4f1eb6e4170ef4cf89e8df099931491a917ab29b688763 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-20T08:42:13Z. Version 1.66.73, release `a29c15d18b48`, commit `a29c15d18b481a82c9e6f5d55a3731a233b1786c` on `hotfix/hbots-16673-antigravity-bots`, working tree clean, result **PASS**.

Machine-readable copy: `releases\a29c15d18b48\gate-evidence.json` (sha256 `18ff14a453bc6c8ddd4f1eb6e4170ef4cf89e8df099931491a917ab29b688763`) and the full gate logs in `releases\a29c15d18b48\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2941 tests passed, 0 failed, 4 skipped, in 213 files | 457.9   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 48.8    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2882 tests passed, 0 failed, 0 skipped, in 257 files | 41      |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 6.8     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 275 checks ok, 0 failed                              | 76.1    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16653\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\a29c15d18b48" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 300.9   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `2c0ac22932f5a6d32aa4aaabb31a7d0ffc18ae1d`, at end `2c0ac22932f5a6d32aa4aaabb31a7d0ffc18ae1d`; tracked files modified: none. Staged release: version 1.66.73, sha a29c15d18b48, dirty False, externals copied; `dist/bin.mjs` sha256 `708278f71b196256b37607bb15ed6da67933dc419ca87ca897b1bb03ae17a6fe`.
<!-- gate-evidence:end -->
