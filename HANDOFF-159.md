# HANDOFF 1.59.0: thinking cloud (Designer spec B)

Staged, not activated: release `08d6844e5055` (commits `20efdbe5b9` feature, `08d6844e50` version, on 1.58.1 `9c38efdc2c`). Includes 1.58.0 and 1.58.1. CTO task f6ea2d89, Frontend.

## What changed

- While a bot is thinking (turn started, nothing out yet), a thought cloud sits at the avatar's upper-right with two tail dots from the shoulder. Bots rows: 26x17 with 3 pulsing dots. Pinned tiles: 22x14.5 with dots. Chat header: 17x11 mini cloud, no dots, swells every 1.6 s. Task cards and Team nodes stay static.
- Status text "Thinking": Bots rows (line 2), the pinned tile's accessible name, and the chat header subtitle ("● Thinking · model"). The needs-you states, "Update broke", "Waiting for the computer" and "Using your PC" still win.
- The list's "Thinking" uses the tool-aware `summary.thinking` from 1.58.0 (`currentTurnHasToolStep` clears it). So a turn that goes straight to a tool reads "Working" with the comet at the first tool step, in the list and the header alike. The spec's "accepted quirk" is gone.
- Leaving thinking: the whole layer lifts off and fades over 220 ms (`data-leaving`). It clears on `animationend`, or on a 300 ms fallback timer (offscreen, reduced motion).
- Eyes glance right (at the cloud) 4 times in 5 (`avatarStates.ts` thinkingModel; `avatarMotion.generated.css` regenerated).
- Layout (fixed, state-independent): pinned strip `mt-3` -> `mt-0` plus `pt-4` inside the scroller, and the list after a rendered strip `mt-3` -> `mt-2` (both ChatsScreen renders). The chat header link goes `gap-3` -> `gap-4`.
- Transform/opacity only. `will-change` only on the float and the dots. Reduced motion shows a still cloud. Kill switch `bots:perf-off=anim-thought` renders no layer (the 1.57.3 pose, apart from the gaze bias, which is in the generated keyframes).

Files: `BotAvatar.tsx` (`thought` prop, `AvatarThoughtLayer`, `THOUGHT_LEAVE_FALLBACK_MS`), `botAvatarShapes.ts` (`avatarThoughtCloud`, clouds, anchors, path), `personal.css` (tokens `--personal-thought`/`-ink`, rules, reduced motion), `PinnedStrip.tsx`, `ChatsScreen.tsx`, `BotRow.tsx`, `ConversationScreen.tsx`, `conversationModel.ts` (`THINKING_LABEL`, `conversationHeaderStateLabel`), `botSummaries.ts`, `perfFlags.ts`, `avatarRemotion/avatarStates.ts`.

## Verified

- Gates: web personal 0 (135 files, 1343 tests), web tsc 0. Server untouched.
- Throwaway server (1.58.1 server binary, my web build, fake Claude CLI via binaryPath, PERSONAL_SEED_MODEL=claude-sonnet-5-5, 390x844 touch, dark and light). Five bots thinking on `THINK`, two of them pinned. Clouds match Designer's sheet. The pinned cloud sits inside the strip's padding and the header cloud stays inside the 64 px header. The name is 16 px right of the avatar.
- `FLIP` (new fake word: silent 8 s, then a tool step, then text, then end). Header: Thinking -> Working at 8.4 s, cloud leaving then gone by 8.8 s, then done -> idle. List: thinking -> working with the comet at the tool step, then done -> idle. Strip y 156, list y 285, row 95 tall throughout (no jump).
- Reduced motion: a still cloud. Kill switch: no layer, "Thinking" text kept.
- Perf, 390x844, 4x CPU, 5 runs x 8 s (median): 5 thinking 0.4% dropped, 0 Paint, 0 Layout, 0 raster. Kill switch 0%. 4 thinking plus a synthetic stream 0.2% dropped, 402 paints (all the stream's, same as 1.57.3's stream-only baseline).
- Evidence: `~/.personal-bots/qa/frontend-159/` (m-t-*.json, shots/). Screenshots are copied next to Designer's sheets in `dev-team/design/hbots/thinking-bubbles/build-159/`.

## Rollback

1.58.1 = `5c1bffc60f5c` (staged), 1.57.3 = `09b49d9aa31d` (live at staging time).
