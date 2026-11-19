# Plus sheet: one camera entry, three photos at once

The plus button opens one sheet that holds a single Camera row and the photo grid. Picking three photos and tapping Add 3 photos puts three images in the tray and sends all three.

## Sub-features

- `camera-once` the composer row holds only `Add photos`, the message field, `Attach files` and `Send`. The sheet draws the text `Camera` once.
- `pick-three` three taps in the grid turn the button into `Add 3 photos`, the tray shows 3 previews.
- `send-three` the sent message shows 3 images and the bot receives 3 different files that equal the 3 picked photos.

## How to get to it (user POV)

- Tap the plus button left of the message field.

## Driving it with adb and uiautomator

Preconditions: a chat is open, three photos in `/sdcard/Pictures` (`verify-red.png`, `verify-green.png`, `verify-blue.png`, distinct images).

- **Composer row.** Every clickable node in the bottom band (y > 2100) must be one of `Add photos`, `Attach files`, `Send` or the message field. Any other control fails, including an unlabeled second camera button.
- **Sheet.** Tap `composer-plus`. Exactly one TextView `Camera` and one `attach-camera` node are drawn. Screenshot `f3-plus-sheet.png`.
- **Pick.** Tap the first row of the embedded grid (`attach-photos`) three times at one third of its width each. The visible button reads `Add 3 photos`. Tap it. Tray nodes `Preview <file>` number 3.
- **Send.** Type `PHOTOS3`, Send. The sent bubble shows 3 ImageButtons with 3 different names. The fake bot log prompt lists 3 `Attached image` paths and their sha256 sums equal the sums of the three fixtures.

## Gotchas

- The embedded grid draws no accessibility nodes per photo. The driver taps by position inside `attach-photos`.
- The picker renames files (`23.png`), so identity is checked by sha256, not by name.
- The dump also lists nodes hidden behind an open sheet. The composer row is read before the sheet opens.
