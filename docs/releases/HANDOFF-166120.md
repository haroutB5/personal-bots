# 1.66.120: Android keyboard reachability and update vibration

Based on 1.66.119 (`ef0f74fdcddd`). Branch `release-candidate/hbots-166120`. No migration; the schema is unchanged. `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

The 1.66.120 verification found that the keyboard lift worked only on the first open. After the keyboard had closed once, the next open left the composer, the secret card and the API key error behind it. The update action notification was still silent.

## What changed

- **Save secret stays reachable while you type.** The pending secret card is bounded to the measured message-list height while the keyboard is open. Its Decline and Save row is pinned at the card bottom and its body scrolls. The Computer dock hides with the keyboard up and returns when it closes. The card reveals at the inverted list's visual bottom. `useKeyboardInset` keeps its closed-keyboard base height across hides, because an edge-to-edge window does not lay out again when the IME closes. That makes the lift work on every open, not just the first.
- **API key address error shows above the keyboard.** The page adds the IME inset to its scrollable padding. A missing allowed address focuses the field and scrolls its bottom to 12 dp above the keyboard. The message sits directly above the field.
- **Update action notification vibrates.** Android fixes a channel's vibration at creation, so the action notifications move to `app_updates_actions_v2` with vibration enabled. Receipts stay on the silent `app_updates` channel. `UpdateChannels` holds the policy as data, and the Kotlin test pins the new id and the vibration.

The layout math is in `chatKeyboardLayout.ts` and has four cases built from the Verifier's measurements. `apiKeyForm.ts` has the scroll target, and `keyboardInset.ts` has the base-height rule. The Kotlin gate runs `UpdateChannelsTest`.

## Rollback

Binary only. The previous release is `ef0f74fdcddd` (1.66.119). No migration ran.

## Known and accepted

- Builder did no emulator, device, Metro or browser check (Harout, 5 Nov). Verifier passed the 1.66.120 recheck at `55152cf60b` on the emulator. Harout owns the real-phone check.
- The real arm64 APK is unverified on Harout's phone.
- The focused API key address field box runs 36 px (12 dp) under the IME top. The error and the text line are visible and typing works. Cosmetic.
- After the keyboard closes, the chat list can leave the secret field under the header. The user scrolls down a little to tap it again. This is scroll position, not the inset.
- Rotation or a window resize while the keyboard is closed is untested.
- Only `NewChatSheet` was checked among the inline sheets. `RenameChatSheet`, `ModelSearchSheet` and `ChoiceSheet` share the shell.
- A device that already ran 1.66.119 keeps the old `app_updates_actions` channel entry. New action notifications use `app_updates_actions_v2`.
- `packages/personal-client/package.json` still reads 1.66.113, as in earlier releases.

## Verification

- Verifier recheck at `55152cf60b` PASS, all four checks. Report `/home/harout/Claude/AI/dev-team/qa/hbots-166120-verify/REPORT.md`, recheck section.
- Parity `--require-done A6,A7,A8,A9,A10,A11,A12,A13,A14,A15,A16 --android-ref release-candidate/hbots-166120` exit 0.
- The personal contract diff against `1e3d39d73f` is empty.
- All 18 RC gates exit 0 at the evidence commit.
- The gate table and logs are in `/home/harout/Claude/AI/dev-team/qa/hbots-166120-rc/REPORT.md`.
