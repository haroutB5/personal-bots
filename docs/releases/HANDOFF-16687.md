# hbots 1.66.87: a steer no longer races the old prompt, and OpenCode talks while it works

Two fixes from the first day on 1.66.86.

## Changes

- **A steer can no longer fail with "Session already has an active ACP prompt".** The adapter cancels the running prompt, waits for it, then sends the owner's new message. The agent can clear its own active-prompt flag a moment after its cancelled response, so the new prompt was occasionally refused and the turn failed with that error. The prompt is now retried up to 15 times, 200 ms apart, only for that refusal; any other error still fails at once.
- **OpenCode 2 bots narrate progress.** DeepSeek on OpenCode 2 stayed silent until its final answer, unlike the Claude bots. Every OpenCode 2 turn now carries one short line asking it to write a sentence after each tool call, or before a long step, saying what it found and what it is doing next. It is appended to the turn prompt, not the persona file, so it applies to sessions that are already open. It adds about 35 tokens to an OpenCode turn; other providers are untouched.
- No schema change, no provider settings change, task concurrency stays 5.

## Validation

- Adapter tests against the real ACP runtime: a first prompt refused with "already has an active ACP prompt" is retried and completes; the steer path still ends the first turn and completes the second; the narration line is present in the request the agent receives (13 focused tests passed).
- Server typecheck passed; changed-file lint and formatting passed.

## Runtime and activation

No migration (112 to 112), no production backup per Harout's 20 Oct rule. Roll back to `e89f457dd14d` (binary only) if the smoke fails. The compact work log from 1.66.86 is already live; this release only changes the OpenCode adapter.
