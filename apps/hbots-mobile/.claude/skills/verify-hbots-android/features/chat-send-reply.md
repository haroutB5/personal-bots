# Chat: send text and get a reply

A user opens a bot from the Chats tab, types a message, taps Send, and sees their text and the bot's reply. The chat returns to Idle with no Stop button.

## Sub-features

- `chat-open` the first open of a bot with no chats shows the New chat dialog, Start chat opens it.
- `chat-send` the sent text appears as a bubble.
- `chat-reply` the reply streams and completes, the status returns to Idle.

## How to get to it (user POV)

- Chats tab, tap the `Developer, <model>, <status>, <preview>` row.
- Tap `Start chat` when the dialog `New chat with Developer` shows.

## Driving it with adb and uiautomator

Preconditions: paired phone on the Chats tab, `Developer` has no chats.

- **Open.** Tap the `Developer, …` row (content-desc, the row draws its name as a child TextView). The composer `Message Developer…` is visible.
- **Send.** Tap the field, type `hello_verify`, press `KEYCODE_ESCAPE`, tap `Send`. The fake bot log gets `prompt "hello_verify`.
- **Reply.** Visible TextViews `hello_verify` and `Got it.` appear and a status TextView `Idle · …` shows. No `Stop` node exists. Proof is the screenshot `f1-reply.png` and the fake bot log line.

## Gotchas

- The reply text `Got it.` also appears on the Work tab only when a report asks nothing, flow 4 asserts that it does not.
- The chat takes its title from the first message, so a later `New chat` dialog does not appear for `Developer`.
