# 1.66.108: tapping + opens the Android photo picker

Based on 1.66.107 via personal-bots/main (`27484d7abc`). Branch `fix/hbots-16708`. No migration; schema remains 114. Web only; the server is unchanged.

## Why

On Harout's Oppo Find X9 Pro, tapping + in a chat composer opened Android's generic chooser (Camera / Video / Files / More). The hidden input set `accept="image/*"` only when file attachments were off; with uploads on it had no `accept`, so Chrome offered every source. He wants his gallery: a tap on + should open the system photo picker straight away.

## What changed (`PersonalComposer.tsx`)

| Item      | Change                                                                                                                                                                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tap +     | Opens a hidden `input type="file" accept="image/*" multiple`, which Android Chrome opens directly in the system photo picker (no capture). iPhone and desktop get their normal image picker; that is expected.                                                                                       |
| Hold +    | Long-press (500 ms, the Send hold's own cue), desktop right-click or the ContextMenu / Shift+F10 keys open a small menu: **Photos**, **Camera**, **Files**. Same `Menu`/`MenuPopup`/`MenuItem` components and `personal-menu` styling as the Send hold menu, with the same press-opened close guard. |
| Camera    | `accept="image/*" capture="environment"`, so Android goes straight to the camera app. One photo at a time.                                                                                                                                                                                           |
| Files     | No `accept`, `multiple`: documents (PDF and the rest) as before. Hidden when the server accepts images only (`fileLimit` null), because no file could be attached there.                                                                                                                             |
| Label     | `Add photos, hold for camera or files` (was `Add photos or files`).                                                                                                                                                                                                                                  |
| Unchanged | Drag-and-drop, paste, upload progress, retry, the image compression caps, and the image-only mode are untouched: all three inputs use the same `onPickFiles`.                                                                                                                                        |

## Coverage: other attach entry points

- **Bot chat** (`ConversationScreen`): uses `PersonalComposer`; gets the change.
- **Group chat** (`GroupConversationScreen`): also renders `PersonalComposer`, but passes its own `send` path, and the composer deliberately has no attach button for groups (one image would be paid for once per member; existing test `takes no attachments: a group would pay for one image once per member`). Groups therefore have nothing to open, same as 1.66.107. Enabling group attachments is a separate product change.
- **Files screen** (`FilesScreen.tsx`): a read-only list of chat attachments; no upload control.
- **New chat / New group sheets**: no attach control.
- **Desktop** (`apps/web/src/components/chat/ChatComposer.tsx`): the upstream desktop composer has its own file input; it is not the personal UI and is unchanged.

## Verification

- Unit: `NODE_ENV=test vp test run --project unit src/features/personal/PersonalComposer.test.tsx` (65 passing), including new tests for the three accept/capture values and the hold / right-click menu, menu closing, and image-only mode hiding Files.
- Android: Chrome on the `FindX9Pro` emulator (360 x 785 CSS, DPR 3, dark): a tap on + opens the system photo picker; the hold menu lists Photos, Camera and Files; a photo and a PDF attach and send; screenshots under `/home/harout/.personal-bots/qa/hbots-16708/`.
- Gate: server and web typechecks, server and web fork tests, and the Linux five-journey e2e (Gate evidence section below, written by gate-evidence.mjs).

## Not done, on purpose

- Group chats still have no attachments (see above).
- No new dependency, no styling tokens added.
