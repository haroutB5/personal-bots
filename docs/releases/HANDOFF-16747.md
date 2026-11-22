# 1.67.47: smooth pinned-bots drag-to-reorder (Android)

Based on 1.67.46 (`930b9ae3ec80`, trunk `04330c3ef2`). Branch `hbots-pinned-drag-anim` is strictly fast-forward on top of trunk; schema version unchanged at 160. This release ships Android APK 1.67.47 (plus the server version bump to 1.67.47; no server code change).

## Why

Reordering the pinned bots strip on the Bots screen jumped: the held tile only followed the finger, the neighbours stayed put until the drop, and on drop every tile snapped to its new place with a visible flash. Harout asked for a smooth, phone-like reorder.

## What changed

- **Pinned strip drag (`apps/hbots-mobile/src/shell/BotsScreen.tsx`).** Long-press lifts the held tile (spring to 1.1x) and draws it above its neighbours. While dragging, the neighbours slide aside live to open a gap at the hover slot. On drop the tile glides into that slot (180 ms ease-out) before the order commits. Releasing in the same slot springs everything back and saves nothing. The drag is clamped to half a tile past either end.
- **No jump on commit.** Tiles are mounted in a stable order and placed by one native-driven `translateX` each, so committing a reorder moves no native view in layout and the landing position equals the new resting position. The mount order resets to the visual order when the screen is hidden or a screen reader is on (traversal order), with x set in a layout effect.
- **Reduce motion.** With "Remove animations" on, the same steps run with 60 ms timings.
- **Pure maths (`apps/hbots-mobile/src/shell/pinnedOrderModel.ts`)** `pinnedShiftFor`, `pinnedSettleOffset`, `pinnedRenderOrder`, `pinnedRestX`, `clampDragDx`, with tests in `pinnedOrderModel.test.ts`, including the no-jump invariant over every from/hover pair and mount order.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to `1.67.47`.

## Release notes for the phone

- Reordering pinned bots is now smooth: the held bot lifts, the others slide out of the way, and it glides into place when you let go.

## Migration

None. Max migration is 160 in `Migrations.ts` on trunk and on the head, and `apps/server` has no diff. Params use `--migration-before 160 --migration-after 160`, so the runner skips the backup.

## Verification

Emulator check (Opuser, 22 Nov 2026) on the laptop AVD `FindX9Pro-QA` (driven only through the T3 device tools / agent-device), x86_64 throwaway APK of `d68e1c3b51` built on the gaming PC rig (sha256 `db5351b5346582d33e926c1ac7eca17765282eaa6e71342b3eebf27336386312`), paired over a quick tunnel to a throwaway server root (`throwaway-server.mjs`, fake providers, 4 pinned bots). Evidence in `dev-team/qa/9c9bf28f/ev/`:

- (a) Long-press lifts and scales the tile, drawn above its neighbours: PASS (`sheet-c-1.png` frames 10-23, `sheet-c2.png` frames 6-15, `c-drag-assistant-to-3.mp4`).
- (b) Dragging slides the neighbours aside, neighbours never overlap: PASS (`sheet-c-1.png`, `sheet-c-2.png`, `sheet-c2.png`), rightward 0 to 2 and leftward 3 to 0.
- (c) Drop glides into the slot with no jump or flash; order persists after leaving and returning and after a cold relaunch, and in the server database: PASS (`sheet-c-drop-allframes.png`, `c-after-leave-return.png`, `c-after-relaunch.png`).
- (d) Release in the same slot springs back, no reorder, no sheet: PASS (`sheet-d.png`, `d-same-slot.mp4`).
- (e) Long press without moving opens the actions sheet for the right bot after a reorder: PASS (`e-longpress-sheet.png`).
- (f) Tap opens the bot (the moved Researcher tile opened Researcher): PASS (`f-tap-opens-researcher.png`, `f-chat-open.png`).
- (g) With animations removed (all three scales 0), drag, drop, persistence and long press still work: PASS (`sheet-g.png`, `g-noanim-after.png`, `g-noanim-longpress-sheet.png`).
- (h) TalkBack Move left/right: not run. TalkBack would not bind on the AVD while the agent-device UiAutomation helper was attached (`touchExplorationEnabled=false`, no bound service). Covered by the existing `moveLeft`/`moveRight` accessibility actions (unchanged `movePinnedBySlot`) and the `pinnedRenderOrder` screen-reader normalisation tests.

Gates: `gate-evidence.mjs` with `gates-linux.scoped.json` (section below).

## Rollback

Binary rollback to `930b9ae3ec80` (1.67.46). No data change, so no data restore.
