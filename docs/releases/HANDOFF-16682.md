# hbots 1.66.82: OpenCode 2 efficiency, a plan filter and counted usage

1.66.81 put bots on OpenCode 2's native ACP path. Running them there showed four things worth fixing: the persona was repeated in every prompt, a message sent during a turn failed instead of waiting, Go usage was invisible in Token usage, and the model list mixed the subscription and pay-as-you-go plans with no way to tell them apart. This release fixes all four and keeps the v2 protocol work unchanged.

## Changes

- **Persona in the session, not every prompt.** The runtime notes and the bot's instructions are written to `<stateDir>/opencode-v2/instructions/<threadId>.md` and named in OpenCode 2's `instructions` config. The agent reads them once when the session starts, so each turn carries only the owner's message and its turn context. The prompt prefix stays stable (DeepSeek's context cache keeps hitting) and roughly 650 new input tokens per step disappear. A rewrite of the file is picked up by the next session; the live session keeps the persona it started with.
- **A message sent during a turn waits.** OpenCode 2 has one ACP prompt in flight per session. A second send used to fail with "Wait for the current registry-agent turn to finish." It now queues behind the running turn and starts as its own turn when that one ends (a per-thread FIFO in the adapter; interrupt still ends the running turn and releases the next one).
- **Token usage counts the app-owned OpenCode 2 store.** The usage scan now reads `<stateDir>/opencode-v2/data/opencode/opencode.db` (the `session_message` rows 1.66.81 already understood) in addition to the owner's v1 store, so Go turns and their cached input appear in Token usage. The split line shows the cache share, e.g. `in 4.2M · cached 110.0M (96%) · out 1.2M`.
- **Go subscription or API pay-as-you-go filter.** Where a provider lists both `opencode-go/…` (included in the Go subscription) and `opencode/…` (API PAYG) models, the chat model picker and the bot form's model search show `All`, `Go sub` and `API PAYG`. Other providers, and OpenCode installs that list only one plan, show no extra row.

## Validation

- Focused server tests: OpenCode 2 environment/config, the real ACP mock adapter (including two sends during one turn, both completed in order) and the usage service with a seeded v2 store. 29 tests passed.
- Focused web tests: the plan split, the model picker, the token split and Token usage. 74 tests passed.
- Server and web typechecks passed. Changed-file lint and formatting passed.
- Real Go Plus run against the owner's subscription and the installed 2.1.3 binary: the adapter's live test passed, including the new persona check. The persona was supplied only through the session instructions file and the turn prompt did not repeat it; the agent still answered with the phrase (`PLUM-42`). The same run covered a reply, a resumed session, full-access tools without a permission prompt, and a permission request after resuming in supervised mode.
- Cache evidence on the live v2 store before this change: the CTO's long session had 3,855,872 cached input tokens against 99,177 uncached (97.5% of all input), and a cold first turn is always lower. The live adapter run's second short turn recorded 5,120 cached of 5,334 input (96%) with the instructions in the system context. Removing the repeated block and keeping the prefix stable is what lets a long chat stay near 99%.
- A stray OpenCode 2 `serve --service` process from the earlier bring-up had been holding the CLI's fixed port and made the live adapter run fail at start-up. It was stopped by its captured PID; the app itself always starts `serve --stdio --port 0`, so it was never affected.

## Runtime and activation

No schema change (migration 112 to 112); no production backup per Harout's 20 Oct rule. Roll back to the currently live `a96ec65b10e3` (binary only) if the smoke fails. The existing OpenCode instance settings (both instances point at the installed 2.1.3 binary) are unchanged; only the adapter's prompt composition, usage scan and the model pickers changed. Task concurrency remains 5.
