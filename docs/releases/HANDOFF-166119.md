# 1.66.119: Android keyboard, settings errors and computer fixes

Based on 1.66.118 (`0b3f30841a`). Branch `release-candidate/hbots-166119`. No migration; the schema is unchanged. `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

The 1.66.118 verification found six defects. The keyboard hid the secret card and the composer. A failed Save in the API key form looked dead because its message was off-screen. A passing provider test showed no verdict. The chat Computer button still showed its 1.66.117 placeholder. A failed take-control showed a black rectangle, and a refused command closed the modal. The update-permission notification was silent.

## What changed

- **Secret card and composer above the keyboard.** The chat screen is a full-height view. `useKeyboardInset` measures the IME height and the container height, then pads the list and composer by the part of the IME that a window resize did not already remove. The header and chip row stay outside the padded area. The secret card reveal uses `viewPosition: 1` and runs one frame after the inset changes. `SheetShell` uses the same hook instead of its private copy.
- **API key errors beside the field.** `apiKeyFormProblem` returns the first blocking field and its message. The Name, Value and Allowed address fields render their own message, and the screen focuses that field. Command failures render inside the form and scroll the form into view. The expanded Change access form uses the same treatment.
- **Provider test result inline.** `providerTestLine` reads the current smoke check and renders `Passed today HH:MM · N s` or `Failed today HH:MM` under the Test row. The button reads `Testing…` while the request is in flight.
- **Chat Computer button.** The dock button calls `onOpenComputer`. The shell opens the `Computer` tab, the same destination as the web header. The target lives in `chatComputerTarget`.
- **Take control failure.** `takeControlView` models the modal as `live`, `waiting` or `error`. A crashed or locked browser shows the server's detail with a Retry. A refused command keeps the modal open with its message and Retry. A failed live-view URL retries the URL. While Brave starts, the modal names what it waits for. Maximize stays disabled until the live view exists.
- **Update-permission notification.** A new `app_updates_actions` channel uses `IMPORTANCE_DEFAULT` and keeps sound, vibration and badges. The permission and ready notifications post there. Update receipts stay on the old silent channel. `UpdateChannels` holds the policy as data.

Each fix has unit coverage. The Kotlin gate runs `UpdateChannelsTest`. The keyboard hook has four cases, and the settings, provider, chat and computer models have their own tests.

## Rollback

Binary only. The previous release is `0b3f30841a` (1.66.118). No migration ran.

## Known and accepted

- Builder did no emulator, device, Metro or browser check (Harout, 5 Nov). Verifier and Harout own the live check.
- The keyboard fix has no device measurement. The inset approach is inferred from the 1.66.118 IME frame and the app window not resizing.
- The API key error scroll depends on Android scrolling the focused field above the IME. That behaviour is inferred, not measured.
- The take-control error path needs the server to report `crashed` or the command to fail. Both paths exist, but the verifier's original rig failure was not re-run.
- The new notification channel keeps separate settings from the old silent channel on a device that already ran 1.66.118.
- Group chats still render no feed cards.
- `packages/personal-client/package.json` still reads 1.66.113, as in earlier releases.

## Verification

- Parity `--require-done A6,A7,A8,A9,A10,A11,A12,A13,A14,A15,A16 --android-ref release-candidate/hbots-166119` exit 0.
- The personal contract diff against `0b3f30841a` is empty.
- The gate table and logs are in `/home/harout/Claude/AI/dev-team/qa/hbots-166119-rc/REPORT.md`.
