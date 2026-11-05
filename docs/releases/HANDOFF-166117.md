# 1.66.117: Android cards, tasks, files, bot page and groups

Based on 1.66.116 (`21b26ec609`). Branch `release-candidate/hbots-166117`. No migration; schema stays 114. `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

The Android app gains the rest of the hbots screens around the chat. A phone can answer a question or a delegation card, settle a secret, login or connection approval card, open chat settings and the side panels, work through tasks and routines, browse and delete Files, edit a bot, and use a group. The shared models live in `@hbots/personal-client`, so web and phone read one copy.

## What changed

- **Feed and approval cards (A6-A8).** A typed card registry renders question, delegation with work record, lead bot change, memory change and rules usage cards. Secret, login and connection approval cards clear their settled state in place, and the secret value stays in the card, wrapped with `Redacted`, never in the cache, a draft or a log. `FLAG_SECURE` is held while a secret or login card is visible. Chat settings, bot usage, context used and routines open as sheets.
- **Tasks, routines and Files (A12-A13).** Tasks and Scheduled lists with counts, paging, select mode, pause, resume and delete. Task detail shows status, retries, failure, result, work record, parent and children, with stop, retry and open chat. The routine form covers both triggers, all four schedules, time zone, missed-run policy and notify mode. Files groups by bot, searches, previews images and text in a sheet, sends PDFs to the browser viewer and other files through the signed download URL, and supports swipe and bulk delete.
- **Bot page, editor and groups (A9-A10).** Bot threads page with select, long press, swipe delete and archived chats. The bot editor covers every field the web form has, with provider, model, effort, context window, team, fallback and schedule sections. Groups have a conversation screen, round and vote cards, settings, member management, private chat handoff and delete.
- **Shared models.** Feed cards, chat settings, secret access, routines, task presentation, bulk selection, files and groups moved into `packages/personal-client`. The web modules at the old paths re-export them, so the two clients cannot drift.
- **Merge integration.** The three branches conflicted in `AppShell.tsx`, `MessageList.tsx`, `parity.ts`, `parity.test.ts`, the web re-export modules, `nativePersonalClient.ts` and `packages/personal-client/package.json`. Main's chat, outbox and upload code is kept. `conversation/routineStatus.ts` and `routines/routineHook.ts` held the same two functions, so the first became a single caller migration and was deleted. The parity matrix is regenerated.

## Rollback

Binary only. The previous release is `21b26ec609` (1.66.116). No migration ran.

## Known and accepted

- Builder did no emulator, device, Metro or browser check (Harout, 5 Nov). The Verifier and Harout own the live check.
- Group chats render their own round and vote cards, but not the A6-A8 feed cards. `MessageList.cardContext` is optional and the group screen does not build one. Chat screens render every card.
- The task result and markdown preview render as plain text on the phone.
- `packages/personal-client/package.json` reads 1.66.113. It was not part of earlier bumps and is left alone.

## Verification

- Parity `--require-done A6,A7,A8,A9,A10,A12,A13 --android-ref release-candidate/hbots-166117` exit 0.
- All 18 RC gates exit 0 at the RC head. Logs and the gate table are in `/home/harout/Claude/AI/dev-team/qa/hbots-166117-rc/REPORT.md`.
- APK `hbots-1.66.117-arm64.apk`, 41,891,161 bytes, sha256 `aaa763aa82bf00b4a6d6cb4bb3d80ff1a6b3c02e85a527a2177468b10251250f`, one signer `bf2aaabe597d0d35538d995c784d31c029cb1adfcf38d3f958593429273af76f` matching `release-cert.sha256`, versionName 1.66.117, versionCode 1066117, arm64 only.

## Gate evidence

<!-- gate-evidence:begin sha=f61f32559d15b64ddb936b1b7ed9902774bd0d06 release=f61f32559d15 json-sha256=673883ad6c0cf747933caf62629f606e998adad9679ac1a890c5943b33c9fbfb result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0
- personal-client: PASS, exit 0
- hbots-mobile: PASS, exit 0
- hbots-mobile-kotlin: PASS, exit 0
- parity: PASS, exit 0

<!-- gate-evidence:end -->
