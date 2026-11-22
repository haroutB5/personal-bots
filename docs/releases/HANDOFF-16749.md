# 1.67.49: Bots can review videos; honest Tasks counts; swipe time always visible (Android + server)

Based on 1.67.48 (trunk `9f96035d02`). Branch `feat/hbots-video` is fast-forward on top of trunk, with `fix/hbots-tasks-counts` (`54d05bfeee`) merged in at `66bd448a87` (release sha). Schema version unchanged. This release ships Android APK 1.67.49 and server 1.67.49. No file overlaps with 1.67.48.

## Also in this release (from `fix/hbots-tasks-counts`)

- **Scheduled tab (`apps/hbots-mobile/src/tasks/tasksModel.ts`, `TasksScreen.tsx`).** The badge counts only enabled routines; paused routines are listed in a "Paused" section below.
- **Work tab (`packages/personal-client/src/work/projectCards.ts`, `tasksModel.ts`).** An open project counts, and shows as a card, when it has an unfinished linked task (queued, running, waiting, rate limited or interrupted) or a step not marked done (Harout, 22 Nov: "Count any project that has work scheduled, even if it is not currently running and is on pause."). One shared check, `projectHasScheduledWork`, drives both the badge and the cards. A card with nothing running says "Paused" (an interrupted task) or "Not running". Open projects with nothing left fold under "+N quiet projects" at once (the 72 h timer is gone).
- **Project cards (`work/ProjectCards.tsx`).** The subtitle is the project's why, not the chat title.
- **Swipe-revealed time (`apps/hbots-mobile/src/chat/MessageList.tsx` `SwipeMessageRow`, `chat/swipeTime.ts`).** The time sits level with the finger, clamped to the row, so it is on screen on a message taller than the screen.
- Verified on the emulator in the counts task (`/home/harout/Claude/AI/_qa/hbots-tasks-counts/`: `work-tab.png`, `scheduled-tab.png`, `swipe-top/middle/bottom.png`). The planned emulator re-check on the merged build was skipped: hidden Claude Code safety-check approvals kept blocking the device commands (fix planned for 1.67.50). The merge was clean, and the merged head passed every gate below.

## Why

Harout wants to send a bot a phone screen recording (an animation glitch, a flow that goes wrong) and have the bot see what happens. Bots cannot read video, so the server turns it into still frames with real timestamps, a contact sheet and a motion timeline, and hands those to the turn together with the original file. Audio is not analysed.

## What changed

- **Attach a video (`apps/hbots-mobile/src/chat/Composer.tsx`, `AttachSheet.tsx`, `videoDrafts.ts`).** The "All photos" picker offers videos as well as photos. The plus sheet's embedded grid only offers photos, so a new **Video** row under Camera opens the system picker for videos. A video shows as a chip with its duration and size. Limits are checked when it is picked: up to 200 MB and 5 minutes, with a plain notice otherwise ("\"29.mp4\" is 210 MB. Videos can be up to 200 MB."). Other files keep the composer's 25 MB cap.
- **Chunked upload with progress (`outboxNative.ts`, `uploadProgress.ts`, `HbotsNetworkModule.kt` `uploadRange`/`cancelUpload`).** The Cloudflare tunnel caps a request body at 100 MB, so a video (or any file over 16 MB) is sent to `POST /api/attachments/upload/<token>?offset=N` in 16 MB pieces from native code. The server answers each piece with the bytes it has (`202`), and `204` once the file is complete. A bar over the composer shows "Uploading 28.mp4 · 64 MB of 180 MB" with Cancel. The bar belongs to the chat it was sent from.
- **Server upload (`apps/server/src/assets/AttachmentUpload.ts`, `http.ts`, `attachmentStore.ts`).** Pieces must arrive in order: a piece at the wrong offset is refused with the size the server holds, so the phone resumes from there, and a piece for a finished file answers complete. Pieces after the first get an hour's grace on the upload token. Size limits in `packages/contracts/src/chatAttachment.ts`: 200 MB for `video/*` and 50 MB for other files (unchanged), enforced on the attachment and the upload-URL schemas.
- **Frames (`apps/server/src/provider/videoFrames/VideoFrames.ts`, `videoAnalysis.ts`).** After the upload, ffmpeg runs once per video, one video at a time, at low CPU and IO priority, with a 4-minute timeout. It decodes 96 px wide grey frames through a pipe and reads each frame's real presentation time (Android recordings are variable frame rate). Selection keeps the first and last frame, every scene change (mean difference at least 6%), and a baseline every 2 s while the screen changes, capped at 40 frames. Output sits next to the video in `<video>.frames/`: `manifest.json`, `motion.csv`, `sheet_N.jpg` contact sheets (timestamps burned in) and `f_MMmSS.Ss.jpg` frames. Corrupt or non-video input gives a text note instead of images.
- **Motion timeline.** The text block lists when the screen moves and the suspicious moments: stalls (a long gap between changes while moving), one-frame flashes (a frame that differs and then reverts), and sudden jumps (one change much bigger than the motion around it). A change as big as a scene cut, such as leaving the app, is not called a jump.
- **Turn input (`videoTurnInput.ts`, `ClaudeAdapterV2.ts`, `CodexAdapterV2.ts`, `attachmentPrompt.ts`).** The turn gets the contact sheets, then the frames, plus a text block with the duration, size, frame rate, frame list, motion summary, the frames folder and `motion.csv`. It also names `dev-team/tools/video-zoom.sh <video> <start> <end> [fps] [--crop x,y,w,h]` (override with `PERSONAL_VIDEO_ZOOM_TOOL`), which writes every frame in a window with a sheet labelled by frame number and ms timestamp, for glitches shorter than the frame gaps. Frames live and die with the attachment (`AttachmentClaims.ts`, `ResourceCleanupService.ts`).
- **QA tooling.** The fake Claude CLI saves each turn's images to `fake-pids/turn-images/<ts>/`.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to `1.67.49`.

## Release notes for the phone

One item per line (pass each as `--notes $'…\n…'` to the finisher, or `--note` per item to `publish-android-update.mjs`):

1. Send videos in chat (up to 200 MB, 5 min): bots watch them as time-stamped frames and can zoom in on animation glitches.
2. Tasks: Scheduled counts only routines that are on; paused ones are listed below.
3. Tasks: Work counts every project with work still planned, including paused ones.
4. Project cards show what the project is for.
5. Swipe to see a message's time: it now appears level with your finger.

## Verification

Laptop emulator `FindX9Pro-QA` only (driven through the T3 device tools / agent-device), x86_64 QA build of this branch, paired over a quick tunnel to a throwaway server running the staged release with the fake Claude CLI. Evidence in `dev-team/qa/hbots-16749/`:

- Recorded the pinned-strip drag on the emulator (`emu/recording-raw.mp4`: 32.15 s, 1080x2354, VFR, 107 frames; Assistant dragged to the last slot at 3.7–7.9 s).
- Plus → Video → picked the 0:32 clip → chip "▶ 0:32 · 1001 KB" → sent to Developer: PASS (`emu/01-attach-sheet-video-row.png`, `02-system-video-picker.png`, `03-video-chip.png`, `04-sent.png`).
- The turn received 8 images: contact sheet (7 frames, 0.0–32.1 s) and 7 frames, plus the text block: PASS (`emu/turn/01.jpeg`–`08.jpeg`, `prompt.txt`, `fake-claude-log-excerpt.txt`).
- A real model given exactly those images and text described the drag correctly: Assistant picked up at 4.0 s, mid-slide at 6.0 s, order Developer, Researcher, Planner, Assistant from 10 s, then leaving to the home screen at 30.8 s: PASS (`emu/real-model-answer.txt`).
- Large file: 180 MB (188 MB) 60 s 60 fps clip uploaded in pieces, "Uploading 28.mp4 · 64 MB of 180 MB" with Cancel, then the turn got 2 contact sheets and 31 frames: PASS (`emu/06-big-progress.png`, `emu/turn/big-60s-log-excerpt.txt`). 210 MB clip refused at pick time with the notice: PASS (`emu/08-over-limit.png`).
- Event loop during extraction of the 188 MB clip (3600 frames decoded, 18.2 s): max delay 10.5 ms, p99 6 ms, no timer gap over 20 ms: PASS, under 100 ms (`stall/stall-big-60s.json`).
- Animation review: zoom on the drag (4.0–8.0 s, crop of the strip) has 64 frames, lift #5–12, slide #13–47, drop and settle #48–64 (`zoom/pinned-drag/`). No suspicious moments on the drag. Synthetic clips: a one-frame flash at 2.500 s and a 200 ms freeze at 3.000 s are both flagged in VFR and CFR; a smooth clip has no flags (`synthetic/text-blocks.txt`, `zoom/synthetic-vfr/`).
- Note: the emulator turn ran on the release staged before the scene-cut fix, so its text block still flags the app exit at 30.827 s as a jump. The fix and its test are in `60e00e27b2`; the same recording analysed with that code reports no suspicious moments.
- Unit tests: `videoAnalysis` and `VideoFrames` (frame selection and cap, timestamp names, limits, corrupt and non-video input, flash/stall/jump/cut), `AttachmentUpload`, `attachmentStore`, `chatAttachment` and `videoDrafts`. `attachmentStore.test.ts` and `chatAttachment.test.ts` are not in any gate's selection and were run by hand: PASS.
- Emulator shut down after the run; no `qemu-system`/`netsimd` process left.

## Server requirement

`ffmpeg` and `ffprobe` on the server's PATH (already installed on the laptop). Without them a video still sends; the turn gets the file and a note that frames could not be extracted.

## Context budget

- What grew: `mcpToolListJsonBytes` in `apps/server/src/provider/agentContextBudget.json`, 49770 → 49773 (+3 bytes). The other budget values are unchanged.
- Why: the attachment MCP tool's size limit in its advertised schema went from 50 MB to 200 MB (52428800 → 209715200) so a bot can handle a video attachment.
- Commit `8b8ccecbec`. Approved by Harout in chat, 22 Nov 2026 (~18:57Z): "Approve the 3-byte increase".

## Migration

None. Schema unchanged.

## Rollback

Binary rollback to 1.67.48 (`9f96035d02`). Videos already sent stay as plain file attachments; their `.frames/` folders are removed with the attachment. No data change.

## Gate evidence

<!-- gate-evidence:begin sha=66bd448a87ff3e0f1dc17713f52129d926a8305b release=66bd448a87ff json-sha256=05cc58ce842f1bffd6fd7c458a6400425c15b47ed75771158f359ee4c2c8bcc2 result=PASS -->

- server-tests: PASS, selected: server-tests inputs changed: apps/server/src/assets/AttachmentUpload.test.ts, apps/server/src/assets/AttachmentUpload.ts, apps/server/src/attachmentStore.test.ts, apps/server/src/attachmentStore.ts, ...; selected 526 test files
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, selected: e2e inputs changed: apps/server/src/assets/AttachmentUpload.test.ts, apps/server/src/assets/AttachmentUpload.ts, apps/server/src/attachmentStore.test.ts, apps/server/src/attachmentStore.ts, ...; selected 12 journeys
- personal-client: PASS, exit 0
- hbots-mobile: PASS, exit 0
- parity: PASS, exit 0
- release-tools: SKIPPED, skip: no changed path is an input of release-tools: scripts/personal/linux, scripts/personal/node, scripts/personal/migration-check.cjs, scripts/personal/sqlite-, scripts/personal/copy-externals.mjs, scripts/personal/idle-classification-, scripts/personal/dsh-runtime, scripts/personal/release-runner
- hbots-mobile-kotlin: PASS, selected: hbots-mobile-kotlin inputs changed: apps/hbots-mobile/modules/hbots-camera/android/src/main/java/expo/modules/hbotscamera/HbotsCameraModule.kt, apps/hbots-mobile/modules/hbots-network/android/src/main/java/expo/modules/hbotsnetwork/HbotsNetworkModule.kt; selected 1 Gradle tasks
- not run by any gate: apps/server/src/attachmentStore.test.ts
- not run by any gate: packages/contracts/src/chatAttachment.test.ts

<!-- gate-evidence:end -->
