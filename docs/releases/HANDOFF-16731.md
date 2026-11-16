# 1.67.31: chats stay smooth while a reply streams, quote the whole reply, midnight labels on time, Work card fix

Based on 1.67.30 (`250e2e23c635`, trunk `97fe283a0a`). Branch `rc/1.67.31` is cut from trunk and holds three merges, in this order: `perf/stream` (`c09ae66712`), `fix/sqlite-watchdog-test-linux` (`7c42dd4139`) and `fix/work-card-hidden-bot-not-a-question` (`4aed04d27b`). The branches share no file. There is no migration, so the schema stays at 159.

## Why

Harout asked for smoother chats. A long reply being written redrew every row of the chat on every update. The Work tab also showed "asked a question" cards for routine reports that asked nothing.

## What changed

- **Streaming list.** A chat row draws again only when what it draws changed, and the reversed rows are computed once per rows array. Measured on the laptop emulator, JS work per streamed reply fell from 7,250 ms to 1,250 ms (median) and an idle open chat from 990 to 1,910 ms per 15 s down to 210 to 240 ms. The lead's bar of 500 ms per reply was missed and the rest goes back to the Architect.
- **Metric.** A `[perf] stream-commit-ms` log line and one beacon per reply, accepted by one server route. The beacon is read by nothing else.
- **Day labels.** The "Today" to "Yesterday" divider turns from the list's own 30 s clock.
- **Swipe to reply.** The quote is the reply as it is now, not the first chunk it had when the row appeared.
- **Work card.** A reply with no choices block gives no card for any bot. A hidden bot's real question keeps its card with question and options null, so the wire shape does not change.
- **Tests.** The release-tools sqlite watchdog tests accept how Linux reports a killed process (signal SIGKILL, not exit 1). No app or server code changes. Dev dependency `react-test-renderer` 19.2.3 is added for the list tests.
- **Version.** `scripts/personal/app-version.txt` and `apps/hbots-mobile/package.json` move to 1.67.31.

## Release notes for the phone

- Chats stay smoother while a long reply is being written, and an open chat uses less battery when nothing is happening.
- Swiping a reply to quote it now quotes the whole reply.
- The "Today" and "Yesterday" labels between messages change on time at midnight.
- The Work tab no longer shows "asked a question" for a bot with hidden previews when it only sent a report.

## Migration

None. `Migrations.ts` has no diff against trunk and the highest id stays 159. Params use `--migration-before 159 --migration-after 159`, so the runner skips the backup.

## Verification

- Device proof and recheck of the stream head on the laptop emulator, `dev-team/qa/hbots-optimise/stream/verify/VERIFY-stream.md`: 18 scripted steps, no stale row, nothing visible differs.
- Work card fix, lead proof in `dev-team/qa/hbots-16731/lead/card/`: red 1 of 31 on trunk's rule, green 31 of 31. Not checked on a device or against the live database.
- Not covered by any proof: group chat rows, delegated task and goal cards, queued and failed sends, plan and html-render rows, a real arm64 phone, light mode (the app is dark only).
- Release checks run with the installed scoped tool and `gates-linux.scoped.json`. This release changes `pnpm-lock.yaml`, so every check runs whole, including release-tools and Kotlin.

## Rollback

Binary rollback to `250e2e23c635` (1.67.30) plus its APK. The database is unchanged by this release.
