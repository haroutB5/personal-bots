# Work cards and in-app versus push

The Work view on the Tasks tab shows a card only for a bot question that is still unread. A reply that lands while the user watches another screen of the app is taken in-app, with no phone push. A reply that lands while the app is in the background goes out as a push.

## Sub-features

- `work-unread-only` one card for an unread question, none for a question already read in its chat, none for plain reports.
- `presence-in-app` while the Tasks tab is open the user sees `Working · …` and then `No bot is working right now.`, and the server logs `path: 'in-app'` for the reply.
- `presence-background` the server logs `path: 'push'` for a reply while the app is in the background, and back in the app the bot's row shows the reply as its preview.

## How to get to it (user POV)

- Tasks tab, Work. The tab opens on it.

## Driving it with adb and uiautomator

Preconditions: `Planner` and `Researcher` chats are seeded in this order.

- **Seed.** In `Planner` send `LATEQ4` and leave at once, so the question `Which build should go out tonight?` lands unread 4 s later. In `Researcher` send `CHOICES`, wait for `Ready to ship the release?` on screen, then leave (read).
- **Flow 5.** In `Developer` send `SLOW6`, leave, open the Tasks tab. The visible text `Working · …` shows on the Running now card, and after the reply `No bot is working right now.`. The server log records `personal notification path` with `path: 'in-app'` and nothing else (`f5-paths.txt`).
- **Flow 4.** On Tasks, exactly one `work-question-*` card and one `work-open-chat-*` button are drawn. The visible text `Which build should go out tonight?` and `Planner · …` show. No text `Ready to ship the release?`, `Slow job finished.`, `Got it.` or `Summary line for the long report` shows (`f4-work-texts.txt`).
- **Flow 6.** In `Researcher` send `SLOW7`, leave, press Home. The server logs `path: 'push'` only (`f6-paths.txt`). The app is relaunched on the Chats tab, and the `Researcher` row's preview text reads `Slow job finished.`. `Researcher` is not `Developer`, so flow 5's data cannot satisfy this.

## Gotchas

- A reply that lands while the user watches the chat counts as read. A card needs the reply to land after the user left, which is why `LATEQ` exists.
- Web push recipients must be bound to a live auth session or the server logs no `push` line. `srv.mjs fakepush` does that.
- The `Work, N` counter chip is not asserted. It showed 0 beside a visible card on 1.67.37.
- The in-app versus push decision itself is only visible in the server log. The screen assertions prove the user-visible half: the working card and its clearing (flow 5) and the reply preview (flow 6). A push notification is not drawn here, because the fake recipient is not a real device.
