# hbots 1.66.88: a steer keeps waiting while the agent is still busy

One fix on top of 1.66.87. The busy-prompt wait it added was too narrow to hold under load.

## Changes

- **"Internal error: Session already has an active ACP prompt" no longer fails a steer.** 1.66.87 recognised this refusal only in the exact wording and only for 3 s (15 tries, 200 ms apart). The OpenCode 2 agent actually answers `Session already has an active ACP prompt: <sessionId>`; the trailing id and any wording change slipped past the exact match, and on a busy machine the flag can stay set longer than 3 s. The match is now case-insensitive and suffix-independent (`/already has an active acp/i`), and the bounded wait is 40 tries, 250 ms apart (10 s). A steer therefore waits for the running turn to clear instead of failing and aborting the tool calls that turn had in flight. Any other error still fails at once.
- The match lives in one exported helper, `isAcpPromptBusyError`, with a test pinning the verbatim OpenCode string and the case and suffix variants, and proving unrelated errors are not retried.
- No schema change, no provider settings change, task concurrency stays 5.

## Validation

- Adapter tests pass: 6 of 6 in `src/provider/Layers/NativeAcpAdapter.test.ts`, including the new verbatim-string case.
- Server typecheck exit 0 (suggestions only, no errors).

## Runtime and activation

No migration (112 to 112), no production backup per Harout's 20 Oct rule. Roll back to the previous live release (binary only) if the smoke fails. Only the ACP adapter changed; nothing else in the app is touched.

## Gate evidence

Written by `scripts/personal/gate-evidence.ps1` after the gates ran.
