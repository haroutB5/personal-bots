# Swipe a reply to quote it

Swiping a bot reply to the right opens a reply bar that quotes the reply. For a long reply the bar holds the first 300 characters of the whole text followed by an ellipsis, not the first streamed chunk.

## Sub-features

- `quote-open` swipe right on a reply opens the `Cancel reply` bar.
- `quote-whole` the bar text is a prefix of the full reply, 280 or more characters, ending in `…`.

## How to get to it (user POV)

- In a chat, drag a bot reply from left to right.

## Driving it with adb and uiautomator

Preconditions: flow 1 left the `Developer` chat open.

- **Reply.** Send `LONGMSG`. The fake bot answers a 1009 character report that starts `Summary line for the long report.` and ends `End of the long report.`. Wait for the visible text `End of the long report.`.
- **Swipe.** `input swipe 100 y 460 y 400` at the height of that last line. The reply bar appears (`Cancel reply`).
- **Proof.** The quote text in the bar is 299 characters, a prefix of the full reply, ending in `…`. Screenshot `f7-quote.png`. A first-chunk quote is about 24 characters and fails.

## Gotchas

- The top of a long reply scrolls off screen, so the swipe targets the last paragraph. The whole message is one swipe target.
- The fake streams a reply in one burst, so a first-chunk bug of the old streaming kind is only caught when the quote is much shorter than 300.
