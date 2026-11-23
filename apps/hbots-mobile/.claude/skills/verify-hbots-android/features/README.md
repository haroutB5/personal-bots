# hbots Android verification map

The maintained source for what a phone release must still do. `scripts/drive.py` drives every flow below in this order. Read the index, then the matching feature file.

## Baseline preconditions

- A throwaway server runs the staged release folder read only (`VERIFY_RELEASE`, default `current.txt`) on `VERIFY_SERVER_PORT` (34671) with an empty data dir. Never port 38472, never `~/.personal-bots/dev`.
- The fake Claude CLI (`scripts/personal/testing/fake-claude/cli.js` of this checkout) answers every bot. Triggers used: `LONGMSG`, `CHOICES`, `SLOW<n>`, `LATEQ<n>`, `SAFETYQ`, `MCPTOOL request_secret` (flow 12), `MCPONCE delegate_task` with a `BGSTART` objective (flow 14; MCPONCE, so the continuation after Interrupt does not delegate again). Any other text gets `Got it.` plus the quote it received.
- Seeded bots: `Assistant`, `Researcher`, `Planner`, `Developer`. Three photos (`red`, `green`, `blue`) sit in the emulator library.
- The phone is the emulator at 1080 x 2355, 480 dpi (360 x 785 CSS px, DPR 3), dark mode, paired through a quick tunnel (the app pairs over https only).
- One fake web push recipient is bound to the phone's session, so a reply nobody sees logs `path: 'push'`.

## Driving conventions

- Assert the text the user sees (the `text` attribute) and require the node to be drawn on screen. A `content-desc` or resource id may locate a control that draws no text, never proves a value. Three places have only a description to read: the composer's icon buttons (flow 3), the photo previews and sent thumbnails (flow 2, which also compares sha256 of the files), and the tab icons used to navigate.
- Give each case its own trigger text. The two presence flows also use different bots: flow 5 `Developer` with `SLOW6`, flow 6 `Researcher` with `SLOW7`. Each asserts text on its own bot's row or card, so one cannot pass on the other's data.
- A dump costs about 2 s. Handles that never move (tabs, Back, composer row) are read once and reused. Waiting for the bot to receive a message polls the fake bot log, and waiting for the in-app or push path polls the server log. Every other wait polls `uiautomator dump` about every 2.4 s (0.35 s sleep plus the dump).
- The keyboard stays up after Send. The driver closes it with `KEYCODE_ESCAPE` before tapping Send and leaves chats with the in-app Back button, except flow 8, which uses the system Back key.
- Never press Redeem. Never type a real credential. The pairing link is typed into the app and never printed.

## Features

| Flows   | File                                                   | Covers                                                          |
| ------- | ------------------------------------------------------ | --------------------------------------------------------------- |
| 1       | [chat-send-reply.md](./chat-send-reply.md)             | Open a chat from the Bots list, send text, the reply completes  |
| 7       | [swipe-quote.md](./swipe-quote.md)                     | Swipe a long reply, the whole reply is quoted                   |
| 9       | [long-press-reply.md](./long-press-reply.md)           | Long press a message, Reply puts the quote in the composer      |
| 3, 2    | [attach-photos.md](./attach-photos.md)                 | One camera entry, no second camera button, three photos at once |
| 4, 5, 6 | [work-and-presence.md](./work-and-presence.md)         | Work cards, in-app versus push                                  |
| 8       | [open-and-back.md](./open-and-back.md)                 | Open a chat from each tab and go back, logcat clean             |
| 10      | [tool-approval.md](./tool-approval.md)                 | Tool approval card: Approve, Deny, 2-minute auto-decline        |
| 11      | (drive.py f11)                                         | Restart laptop: hold, confirm, restarting (server dry run)      |
| 12      | [secret-card.md](./secret-card.md)                     | Secret card: address problem on screen above Save, then saved   |
| 13      | [email-integrations.md](./email-integrations.md)       | Settings, Integrations, Email: the no-bridge repair state       |
| 14      | [working-in-background.md](./working-in-background.md) | Task waiting on background work: card, row and header agree     |

## Not covered

A real arm64 phone, FCM push, the camera itself (only that its entry exists once), voice, reconnect windows, Settings, Team, Files content, light mode.
