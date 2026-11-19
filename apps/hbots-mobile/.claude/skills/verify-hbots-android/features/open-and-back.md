# Open a chat from each tab and go back

Opening a chat from the Chats list and from a Work card, then pressing the system Back key, returns to the list. Visiting every tab leaves the app alive with no crash and no JavaScript error.

## Sub-features

- `open-chats` Chats list to `Researcher` and back. The chat shows its question `Ready to ship the release?`.
- `open-work` Work card `Open chat` to `Planner` and back. The chat shows its question `Which build should go out tonight?`.
- `tabs` Computer (`THIS LAPTOP`) and Files (`No files yet` or a file name) open and close.
- `logcat-clean` no `FATAL EXCEPTION`, no JavaScript error, app pid alive.

## How to get to it (user POV)

- Tap a bot row, or `Open chat` on a Work card, then use the system Back gesture.

## Driving it with adb and uiautomator

Preconditions: the seed left one Work card and the `Researcher` question (flow 8 needs the seed, like flow 4).

- **Open.** The composer `Message <bot>…` and the status text `Idle · …` show, and the bot's own question shows as visible text, so a wrong chat fails.
- **Back.** Press `KEYCODE_BACK` twice if a keyboard is open (the first closes it). The tab texts `Chats`, `Tasks`, `Computer`, `Files` show again, with the `Search bots and chats` field on Chats and `Running now` on Tasks.
- **Tabs.** Tap Computer (text `THIS LAPTOP` shows), Files (text `No files yet` or a file name shows), Chats.
- **Proof.** `adb logcat -d` for the whole run has 0 `FATAL EXCEPTION` and 0 `JavascriptException` or `ReactNativeJS` errors. Saved as `logcat.txt`.

## Gotchas

- Computer and Files have no chat entry, so they are visited only.
- Android 15 or later predictive back is not exercised by `keyevent`.
