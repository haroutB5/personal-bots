# 1.66.104: switch back to a bot's own model at the next turn

Based on 1.66.103 (d10ff68edf2a). No migration; schema remains 114.

The usage-limit model fallback only switched a bot back to its own model from its 30-second idle sweep, and the sweep required no turn and no task to be running. A bot that stayed busy on a long delegated task therefore kept the fallback row long past its reset time.

Now, when a usage-limit fallback row's reset has passed, or the sweep's two-minute provider re-probe proves the limit reset early, the next turn started on a chat that is between turns ends the row first, so that turn runs on the bot's own model. The check sits in the shared bot-model selection every server-started turn uses (delegated tasks, retries, resumes, group rounds, lead posts, release notices, voice calls and owner turns) and goes through the ordinary switch-back path: the reswitch cooldown, the wakeup of rate-limited tasks and scheduled chat resumes, the one chat line, and the provider switch that carries the chat over to the new session. A chat with a turn still running is left alone, so a steer and the running turn keep the model they started on and nothing changes mid-turn. A re-hit of the limit falls back again, with the existing 60-second cooldown preventing a bounce.

Schedule and DeepSeek-peak rows are not touched by the boundary check and keep their idle-gated switch back. `list_bots` and the chat's fallback label stop showing the fallback model as soon as the row ends.

The personal server suite passed 2,849 tests (six skipped), including three new service tests: a reset that passed while a task is running switches that task's next turn while the running turn keeps its model; the early-reset probe clears the row at the next turn boundary; and a schedule or peak row keeps its idle-gated switch back. The full web unit suite passed 3,122, both app typechecks passed, and the five-journey e2e gate passed. Targeted runs before the gate: `PersonalModelFallbackService.test.ts` 69 passed, the task and resume suites 149 passed, and `ProviderCommandReactor.test.ts` 122 passed.

Evidence: `/tmp/opencode/hbots-166104-fallback-test2.log`, `/tmp/opencode/hbots-166104-related-tests.log`, `/tmp/opencode/hbots-166104-reactor-test.log`, `/tmp/opencode/hbots-166104-server-tests.log`, `/tmp/opencode/hbots-166104-web-tests.log`, `/tmp/opencode/hbots-166104-gate.log`, and the staged release's `gate-evidence.json` and `gate-evidence-logs/`.

## Gate evidence

<!-- gate-evidence:begin sha=6cd69654ab98b5fe79efda75dfdad9500d6cb24e release=6cd69654ab98 json-sha256=157018a21f149233455897f0a0f81e349f6fef61b85c3bdbbb3fcf2e1d45fced result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0

<!-- gate-evidence:end -->
