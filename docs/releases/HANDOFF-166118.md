# 1.66.118: Android settings, memory, computer and update nudge

Based on 1.66.117 (`c03effdf17`). Branch `release-candidate/hbots-166118`. No migration; the schema is unchanged. `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

The phone gets the remaining settings surfaces, the Computer tab and the updater's permission nudge. Three small findings from the 1.66.117 verification are fixed: the revealed login password stays out of the keyboard's learning, the secret card scrolls above the keyboard, and a saved secret keeps its settled card when the chat is reopened.

## What changed

- **Settings, notifications and providers (A14).** Settings root with search, this phone, name, bots, removed bots and providers. Notifications has the device card, test notification, five event switches and delivery history. Provider setup has the instance, add, catalogue, install, confirm, remap, progress, test, models, use, usage and removal surfaces. Keys are accepted for DeepSeek and xAI.
- **Memory, passwords, keys and connections (A15).** Memory search, rules, notes, task summaries, limits, restore, archive, selection and bulk delete, waiting rules, tidy-up, changelog and undo. Passwords and API keys use write-only forms with brokered and environment modes. Connections cover five vendors with check, off, on, remove and import.
- **Computer (A16).** A live browser view, watch-only desktop view, take and hand back control, source switch, browser keys, actions, driver cards, activity and files. Frames stay in one Kotlin bitmap and are never written to disk. The tab holds `FLAG_SECURE` while mounted.
- **Update permission nudge.** The updater posts one notification per target version when Android blocks installs, and Bots home shows a banner that opens the install-permission page. The updater state is reported to client-diag with versions only.
- **Login password reveal.** The revealed field stays Android's visible-password variation with no suggestions, no autofill and no personalised learning. It never becomes a plain text field.
- **Secret card above the keyboard.** Focusing the secret field brings the card into view, and the list repeats the reveal after the keyboard finishes opening.
- **Saved secret receipt.** The device keeps a metadata-only receipt of each settled secret card, so reopening the chat still shows "You saved …". The value is never part of the record.
- **Merge integration.** Main's integrated 1.66.117 tree is kept. The duplicate `memoryPresentation.ts` was migrated to the canonical `memory/presentation` path and deleted. The parity registry unions A6-A16 and the matrix is regenerated.

## Rollback

Binary only. The previous release is `c03effdf17` (1.66.117). No migration ran.

## Known and accepted

- Builder did no emulator, device, Metro or browser check (Harout, 5 Nov). Verifier and Harout own the live check.
- Group chats still render no feed cards. A secret or login request raised in a group appears only in the bot's own chat.
- The saved-secret receipt is per device. Another phone shows the card as closed, because the server keeps no settled-secret stream and the contract is unchanged.
- `packages/personal-client/package.json` still reads 1.66.113, as in earlier releases.

## Verification

- Parity `--require-done A6,A7,A8,A9,A10,A11,A12,A13,A14,A15,A16 --android-ref release-candidate/hbots-166118` exit 0.
- All 18 RC gates exit 0 at the evidence commit. Logs and the gate table are in `/home/harout/Claude/AI/dev-team/qa/hbots-166118-rc/REPORT.md`.
- The personal contract diff against `c03effdf17` is empty.

## Gate evidence

<!-- gate-evidence:begin sha=ed47927abeb295ae74c07cd72e3822ce8810abde release=ed47927abeb2 json-sha256=57160451b442021997286ad89fa5bbf95690d235c9858c128349cadc12741b5d result=PASS -->

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
