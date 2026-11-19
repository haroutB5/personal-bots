# Long press a message, then Reply

Long pressing a message opens the message menu (`Message`: Reply, Copy text, Select text, Cancel). Reply closes the menu and puts the message in the composer's reply bar: the sender's name and the message text, with a `Cancel reply` button. The next message goes to the bot with that quote.

## Sub-features

- `menu-open` a long press on a sent bubble and on a bot reply opens the menu.
- `reply-bar` Reply closes the menu and the reply bar names the sender and shows the message text.
- `quote-sent` the bot receives the quote with the next message.

## How to get to it (user POV)

- In a chat, press and hold a message for about a second, tap `Reply`.

## Driving it with adb and uiautomator

Preconditions: flow 7 left the `Developer` chat open and its reply bar closed.

- **Sent bubble.** Send `LPRESS`, wait for `Idle`. Hold the `LPRESS` bubble (`input swipe x y x y 900`). The visible texts `Copy text` and a `Reply` button show. Tap `Reply`. The menu is gone. The reply bar rows show the visible text `You` and `LPRESS` next to a `Cancel reply` button. Screenshots `f9-menu-the sent message.png`, `f9-reply-the sent message.png`.
- **Quote sent.** Send `LPQ`. The fake bot log prompt reads `[Replying to my earlier message: "LPRESS"]` before `LPQ`. The bot's answer `Got it.` plus `I received this quote with your message: …` shows as visible text.
- **Bot reply.** Hold that answer. Tap `Reply`. The reply bar rows show `Developer` and the text that starts `Got it.` and holds `I received this quote`. Tap `Cancel reply`. The bar is gone.

## Gotchas

- Both the bubble and the bot reply open the same menu sheet. The sheet is the code under test, so a broken Reply there fails both halves.
- Swipe-to-quote (flow 7) does not use the menu. A plant in the menu escapes flow 7 and is caught here.
- The reply bar shows one line. The dump holds the whole excerpt text.
