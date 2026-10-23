# hbots 1.66.85: steering an OpenCode 2 turn

A message sent while an OpenCode 2 bot was working waited behind the whole turn: 1.66.82 queued it, so a 44-step turn could hold the reply for minutes and the steering felt ignored. OpenCode's ACP layer allows one prompt per session and rejects a second one outright. This release uses the one thing it does support.

## Changes

- **A steer ends the running turn and continues in a new one.** When a message arrives while a turn is active and it is not marked `followUp: "queue"`, the adapter cancels that turn (`session/cancel`), waits for it to settle, and starts the new turn with the message. The agent keeps the conversation it already has, so the work up to the steer is still in context; the old turn appears as stopped and the reply starts at once instead of after the long turn.
- **`followUp: "queue"` keeps the old wait.** The queue behaviour from 1.66.82 remains for callers that explicitly ask to queue, so nothing that relied on it changes.
- Intermediate steer messages while a turn is already being cancelled do not cancel twice: the first clears the active turn and the rest queue.
- No schema change, no provider settings change, task concurrency stays 5.

## Validation

- Adapter tests against the real ACP runtime with the mock agent: a steer ends the first turn (one `turn.aborted`) and the second runs to completion (one `turn.completed`); the queue path still runs both turns in order (4 tests passed).
- Server and web typechecks passed; changed-file lint and formatting passed.
- The live ACP probe showed why this shape is needed: a second `session/prompt` while one runs cancels the first and returns `Session already has an active ACP prompt`. The adapter now cancels first and then sends, which the same probe handled cleanly.

## Runtime and activation

No migration (112 to 112), no production backup per Harout's 20 Oct rule. Roll back to `bdee0f76bdff` (binary only) if the smoke fails. The chat-step UI is not part of this release; the mockup is separate and waits for approval.
