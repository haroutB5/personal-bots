# Smooth Team-screen drag, Back returns to the Team screen (1.56.1)

2026-09-29, Frontend (CTO task 17f487fe). Branch fix/team-drag-back (worktree C:/Claude/AI/_wt/hbots-156), on 1.56.0 (1cb9e55fde). Web only; server and contracts untouched. Harout's two findings on his iPhone in live 1.56.0.

## 1. Drag jitter and flicker: cause and fix

Two causes, both in code from 1.56.0 (measured, not guessed):

1. **The finger rendered the whole screen.** `useTeamBotDrag` called `setDrag({point})` on every `pointermove`, so TeamBoard, every constellation card and the drop overlay re-rendered per move, and the token moved with `left`/`top` (layout each frame). At 4x CPU: 128 layouts and 3.4 s of script in a 126-move drag.
2. **The hint banner changed size under the finger.** Its text was one, two or three lines and its "review" tone added a 1 px border, so the drop cards below it jumped 22 px (card top 68 <-> 90 px at 390 wide) whenever the hovered card changed. That moved the card out from under the finger, which changed the hint again: the flicker.

Also cheaper or safer now: the touchmove block is installed at the lift (it was an effect a render later), nodes are `user-select: none` from the first touch (iOS starts selection on the same long press), and the zoom is one CSS transition on one wrapper (will-change released on `animationend`), with the token outside it.

Fix (useTeamBotDrag.ts, TeamMoveOverlay.tsx, TeamScreen.tsx, personal.css):

- A move only records the finger's position. One `requestAnimationFrame` per frame writes the token's `transform: translate3d(...)` straight to the DOM (`tokenRef`, no React) and asks which drop card is under the finger. React is told only when that card changes (`drag` is `{botId, zoneId}` now, no point).
- The constellation cards are one memoised element (deps: data, dragging and moving bot ids), so hint/lit-card changes do not render them again: the layout under the overlay is frozen.
- The banner is 86 px (three lines) in both tones, text centred, clamped to three lines while a finger drags; tap mode keeps the same minimum height and can grow. The full text is always in the live region.
- Reduced motion: the zoom is a 100 ms fade (the app's global rule wins), the token and cards behave the same.

### Numbers (390x844, touch, 4x CPU throttle, real CDP touch events, CTO dragged across every drop card and back, 126 moves; Chrome headless --disable-gpu; median of 5 runs; qa/frontend-1561/trace-before.json, trace-after.json)

|                                             | 1.56.0 (before)                   | 1.56.1 (after)                                              |
| ------------------------------------------- | --------------------------------- | ----------------------------------------------------------- |
| dropped frames (>25 ms)                     | 49 of ~500 (9.6 %)                | 12 (2.4 %)                                                  |
| longest frame while moving                  | 50 ms                             | 33 ms                                                       |
| p95 frame                                   | 33.3 ms                           | 16.8 ms                                                     |
| frames per second                           | 54                                | 58.5                                                        |
| layouts in the drag                         | 128                               | 22 (one per hover change)                                   |
| script time                                 | 3382 ms                           | 866 ms                                                      |
| main-thread task time                       | 6568 ms                           | 4058 ms                                                     |
| long animation frames                       | 1                                 | 0                                                           |
| card top while hovering                     | 68 and 90 (22 px jump), 13 values | 110 after the zoom, 1 value (86 px banner always)           |
| layout-shift score                          | 0                                 | 0 (the API ignores this; the probe above is the real check) |
| the lift (hold, mount, zoom), longest frame | 267 ms                            | 217 ms                                                      |

The lift frame is still the slowest thing (mounting the drop cards, 4x throttled); it is one frame, not the moving. Without the GPU flag, Chrome on this PC shows random 450 ms frames in both builds: they are `DXGISwapChainImageBacking::Present` in the GPU process (found in a trace), unrelated to the page, so the numbers above use `--disable-gpu`.

Evidence in ~/.personal-bots/qa/frontend-1561/: strip-before-dark.png / strip-after-dark.png (eight stationary frames along the path: before, the Dev card sits at two different heights), videostrip-before.png / videostrip-after.png, drag-before.webm / drag-after.webm (4x throttle), chrome-trace-trace-before.json.gz / -after.json.gz (Chrome traces, with tracing overhead), shift-{before,after}-{dark,light}.json and shift-after-dark-reduced.json (per-frame card and banner positions), drag-trace.mjs, shift-probe.mjs, drag-video.mjs.

## 2. Back from a bot opened on the Team screen

Harout's rule: anything opened from the Team screen (a bot's page, its chats, its edit screen, a chat, a "Working now" task chat or task page) returns to /bots/team on Back, by the arrow, the in-app edge swipe or browser Back, with the Team screen's scroll and open members list restored. Everything else keeps going to /bots (the 1.47.3 rule stays for entries that did not start on the Team screen).

- **History state**, not a search param (botsBackStack.ts): `personalTeamBehind` marks an entry whose real predecessor is /bots/team; `personalTeamView` carries the Team screen's view (teamView.ts: scrollTop, anchor card and offset, open members team) on the Team entry (stamped when it is left) and is copied onto everything opened from it. Team -> bot page -> chat/edit replaces the entry (like chat -> chat), so history is always [Team, page] and one Back is enough. `isTeamOpenedPath` is the set: /bots/$botId, its /edit, bot chats, /tasks/$taskId; group chats, /bots/teams/new and settings are not.
- **Arrows** (usePersonalBackTarget.ts): PersonalPageHeader, bot page, chat header, task page, "This bot no longer exists" link and the edit form's leave() all use it: "Back to Team" -> /bots/team, which botsBackStack turns into a real history step back. Others unchanged ("Back to Bots").
- **Edge swipe** (edgeSwipeBack.ts, useChatSwipeBack.tsx): enabled for either kind of entry behind; for a Team origin the underlay is the real TeamScreen (with the saved scroll) and the swipe ends on /bots/team.
- **iOS app kill** (resumeLastChat.ts): the saved last chat now carries `team: true` and its Team view; the 12 h relaunch writes `personalTeamResume` on the reopened chat, and botsBackStack puts /bots/team (with the view) behind it instead of /bots. The chat's "gone" step-back uses the same target.
- **Restore** (TeamScreen.tsx): on mount TeamBoard reads the view from its own history entry, scrolls to the anchor card (raw scrollTop as fallback), re-applies for two frames and 500 ms unless the owner touches, and reopens the members list. A fresh visit to /bots/team has no view and starts at the top.
- Trade-off: from a page the Team screen opened, the Bots tab is a plain push (Back from it returns to that page). New team (/bots/teams/new) is not in Harout's list and keeps its own Back.

Tests: teamBackStack.test.ts (22: each entry point returns to the Team screen by arrow-step and Back; bots-list, task, cold, group and New team entries still go to /bots; view stamped, copied, restored; relaunch), resumeLastChat.test.ts (+3: save with origin, relaunch puts Team behind the chat, arrow step), edgeSwipeBack.test.ts (+1), useTeamBotDrag.test.tsx (5: no render per move, transform only once a frame, touch block from the lift, drop, scroll cancels).

## Verification

- Gates: see the status line in the sheet.
- Real browser (Chrome 390x844 touch, standalone emulated, throwaway server with the fake Claude CLI, seed model Sonnet 5.5, root deleted): back-flow.mjs, 32/32 in dark and light: scroll restored after the arrow and after browser Back (492 px), bot page, edit form, new chat, Working now chat, members list reopened, edge swipe (before and after a simulated app kill: a new tab at /bots reopens the chat and the swipe lands on /bots/team), Forward, a chat from the Bots list still goes to /bots, Team's own Back goes to /bots. 1.56.0 fails the first Back check ("Back to Bots"). Screenshots back-*.png.
- Not checked: a real iPhone (long-press feel, iOS text selection, the swipe strip on Team).

## Release

Staged, restart waiter restart-1.56.1.ps1 (idle rule). Rollback 1.56.0 = 1cb9e55fde42. After it goes live: /version.txt 1.56.1; on the iPhone hold a bot and drag across the teams (no jumping, no flicker), then open a bot from Team, go Back by arrow and by edge swipe.
