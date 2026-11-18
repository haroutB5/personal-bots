# Open a chat from each tab and go back

Opening a chat from the Chats list and from a Work card, then pressing the system Back key, returns to the list. Visiting every tab leaves the app alive with no crash and no JavaScript error.

## Sub-features

- `open-chats` Chats list to `Researcher` and back.
- `open-work` Work card `Open chat` to `Planner` and back.
- `tabs` Computer and Files open and close.
- `logcat-clean` no `FATAL EXCEPTION`, no JavaScript error, app pid alive.

## How to get to it (user POV)

- Tap a bot row, or `Open chat` on a Work card, then use the system Back gesture.

## Driving it with adb and uiautomator

Preconditions: flow 4 left one Work card.

- **Back.** Press `KEYCODE_BACK` twice if a keyboard is open (the first closes it). The Chats and Tasks tab nodes are visible again.
- **Tabs.** Tap Computer, screenshot, Files, screenshot, Chats.
- **Proof.** `adb logcat -d` for the whole run has 0 `FATAL EXCEPTION` and 0 `JavascriptException` or `ReactNativeJS` errors. Saved as `logcat.txt`.

## Gotchas

- Computer and Files have no chat entry, so they are visited only.
- Android 15 or later predictive back is not exercised by `keyevent`.
