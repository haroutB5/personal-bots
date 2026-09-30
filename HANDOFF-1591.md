# HANDOFF 1.59.1: QA bug hunt fixes H1-H6

Staged, not activated: release `1f2049611a77` (version commit `1f2049611a`, on 1.59.0 `5a7b6eb877`). Web only, no server change, no migration. Rollback 1.59.0 = `08d6844e5055`. CTO task 748f14b6, Frontend. Bug report: `~/.personal-bots/qa/hunt-0930/BUGS.md`.

## What changed

| Bug                                                             | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Commit       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| H1 high: archived groups unreachable                            | `mergePersonalGroups` also returns `archivedGroups`. Bots list: collapsed "Archived groups (N)" section at the bottom (like a bot's Archived chats); search matches archived groups too, tagged "Archived". Group screen: an archived group opens read-only with an "Archived. Unarchive to send messages again." banner and an Unarchive button in place of the composer; the menu shows "Unarchive group". Unarchive is the existing `personalGroups.update archived:false`. "This group no longer exists" only when the group is not listed at all (deleted). | `ef8dff5e33` |
| H4 medium: group relay threads in a bot's chat list             | One source: `groupRelayThreadIds` (member threads of open AND archived groups) and `usePersonalGroupRelayThreadIds`. Applied to the bot's chat list (`botThreadRows` takes the set), its "All chats" count, the Bots list rows and search, and Message privately reuse. Push links for group replies already go to the group screen (server); Files has no thread grouping.                                                                                                                                                                                      | `a84c3d6608` |
| H2 medium: deleted or missing chat link stuck on "Loading chat" | `threadLoadProblem` reads the thread state (the server answers "Thread … was not found" and the client retries with that error set). Missing: "This chat no longer exists." + "<Bot>'s chats" button. Other error: "Couldn't load this chat." + Retry (`useRetryEnvironmentThread`) + the same button. Same pattern on the group screen. The task page already handled a missing task.                                                                                                                                                                           | `01733fea5f` |
| H6 medium: pinned long-press menu closes on release             | `usePressOpenedMenuGuard`: the long press arms it as the menu opens; close requests other than item/Escape/close are ignored until the finger lifts (watched on the document) + 350 ms. List-row press-and-hold (chats, files, memory, routines, logins) enters select mode, no menu, so nothing to guard there.                                                                                                                                                                                                                                                 | `4f5695a7c7` |
| H5 medium: New routine default bot differs cold vs warm         | The draft no longer seeds a bot; `defaultRoutineBotId` (Planner, else first) resolves once the list is in; a picked bot is kept.                                                                                                                                                                                                                                                                                                                                                                                                                                 | `465b9d2198` |
| H3 low: Tasks and Computer tabs 40 px                           | Track padding moved into each tab: the tab is the full h-11 (44 px), its own 2 px padding draws the same inset pill. Computer keeps md:h-9 on desktop. Sweep: Appearance, routine choices, weekdays, tab bar were already 44.                                                                                                                                                                                                                                                                                                                                    | `490e358841` |

## Verified

- Gates: web `vp test run --project unit src/features/personal` 0 (137 files, 1361 tests), web tsc 0. Server not touched.
- `build.ps1 -CopyExternals -NoActivate` exit 0; `releases/current.txt` still `08d6844e5055`.
- Throwaway (one data root, fake Claude CLI via binaryPath, `PERSONAL_SEED_MODEL=claude-sonnet-5-5`, 390x844 touch, dark and light): first on the live 1.59.0 release, then on this one. Evidence `~/.personal-bots/qa/frontend-1591/` (`results-old.json`, `results-new.json`, `shots/`, `prove.mjs`).
  - H1 old: no section, no search hit, "no longer exists". New: section with the row, search hit, banner + transcript, Unarchive -> server archived_at null and the composer back.
  - H4 old: 2 relay rows on Assistant's chats. New: 0.
  - H2 old: "Loading chat" after 12 s for a deleted chat and a made-up id. New: "This chat no longer exists." in 0.6-2.0 s (12 timed runs). One prove run's text check fired before it resolved; its screenshot shows the message.
  - H6 old: 4 menu items held, 0 after release. New: 4 held, 4 after release, no navigation, the next tap on Unpin unpinned.
  - H5 old: cold "Updates", warm "Planner". New: both "Planner".
  - H3 old: tabs 40 px. New: Tasks 4x44, Computer 3x44.
- Server stopped by captured PID; root deleted after a junction check (0).

Not checked: physical iPhone Safari (Chrome touch emulation only), desktop mouse pass.

## 1.59.2: H7, All chats count waits for groups

Staged, not activated: release `c0ad253f2963` (commits `99e24f722f` fix, `c0ad253f29` version). Live is 1.59.1 `1f2049611a77`, the rollback. QA's retest found "All chats" in Chat options briefly counting the bot's hidden group relays after a cold load (the relay-id hook returned an empty set while the groups loaded).

- `usePersonalGroupRelayThreadIds` returns null until the groups list or feed answers, or the list fails (`personalGroupsSettled`).
- All chats count (now `AllChatsCount.tsx`): an invisible "0 open" of the same size until the number is right.
- The bot's chat list: no rows until the relays are known.
- Bots list: live rows wait for the groups list as well as the bots (the cold-start snapshot or skeleton stays up); search uses the same rows. Message privately only runs on a loaded group.
- Tests: `AllChatsCount.test.tsx` (pending state, settled count), `personalGroupsSettled`, and a ChatsScreen test with groups arriving after the bots.
- Gates: web personal 0 (138 files, 1366 tests), web tsc 0; build exit 0.
- Throwaway (same harness, QA's retest-count-race.mjs adapted as `h7race.mjs`, 4 cold loads per theme, dark and light): 1.59.1 showed "3 open · 1 archived" in 8/8 runs (two relays); 1.59.2 in 0/8 (the pending placeholder, then "1 open · 1 archived" about 20 ms later). H1 and H4 re-checked on 1.59.2. Evidence `~/.personal-bots/qa/frontend-1591/h7-old.json`, `h7-new.json`. Server stopped by PID, root deleted (0 junctions).

## 1.59.3: H8, first tap no longer waits (perf budgets)

Staged, not activated: release `2a1b2f1ca439` (commits `c7a12cf7d4` preload, `a94f2453e3` relay flag, `2a1b2f1ca4` version). Live is 1.59.2 `c0ad253f2963`, the rollback. QA's live check failed 7 of 11 budget.json limits. Server + web + contracts change, additive, no migration.

- **Chat preload from the first paint** (`c7a12cf7d4`): `usePreloadChatRoute(firstPaintReady)` (snapshot rows count) with a 250 ms idle deadline (`PRELOAD_CHAT_IDLE_MS`). Kill switch `bots:perf-off=preload-chat-soon`. Before, it waited for live rows plus an idle moment (up to 3 s), so with a long list the first tap loaded ~48 chunks / 1.2 MB.
- **Bots list marks relays** (`a94f2453e3`): `personalBots.list` sends `groupRelay: true` on each group relay link (same rule as group presence: any `personal_group_members.thread_id`). `isGroupRelayLink` (flag, or a relay the groups know that is newer than the list) is the one rule for the Bots rows and search, a bot's chat list, All chats and Message privately. The 1.59.2 loading gates are removed: live rows paint with the bots list, so a tap no longer lands on the groups-triggered render. H7 stays fixed: the count is right from its first render.

### Bisect (throwaway, fake CLI, Sonnet seed, 5 runs + warm-up, QA's r1592 ceilings, bot Researcher)

J1-warm wall / longTaskMs, J1-deep wall / longTaskMs, light fixture: 1.30.1 1834/1729, 2656/2202 (the release the budgets were ratcheted from, 23 Sep); 1.53.1 1393/1337, 2148/1808; 1.57.2 1383/1356, 2085/1739; 1.57.3 1362/1138, 2075/1725; 1.58.1 1388/1386, 2086/1715; 1.59.0 1393/1366, 2049/1689; 1.59.1 1390/1125, 2085/1754; 1.59.2 1389/1338, 2104/1721. No regression across 1.53-1.59; 1.30.1 itself misses these four ceilings today by more than 1.59.x. They are out of date for this machine/Chrome, not a code regression, and were left unchanged. J2 depends on list size: it passes on every build with a small list, and with 400 extra chats fails on both 1.59.1 and 1.59.2 (50 requests / 1198 KB).

### Budget table (p50; limit in brackets)

| Metric                    | QA live 1.59.2 | Throwaway 1.59.2, 400 chats | 1.59.3, 400 chats | 1.59.3, light |
| ------------------------- | -------------- | --------------------------- | ----------------- | ------------- |
| J1-warm.wall (1138)       | 1572.6 FAIL    | 1386.1 FAIL                 | 1488.1 FAIL       | 1384.6 FAIL   |
| J1-warm.longTaskMs (960)  | 1521 FAIL      | 1313 FAIL                   | 1406 FAIL         | 1336 FAIL     |
| J1-warm.requests (196)    | 145            | 145                         | 145               | 145           |
| J1-warm.jsKB (3632)       | 2390.7         | 2390.7                      | 2390.4            | 2390.4        |
| J2.chatShell (228)        | 1133.1 FAIL    | 567.5 FAIL                  | 170.5             | 108.2         |
| J2.requests (4)           | 50 FAIL        | 50 FAIL                     | 3                 | 2             |
| J2.jsKB (20)              | 1198.2 FAIL    | 1198.2 FAIL                 | 0                 | 0             |
| J1-deep.wall (1478)       | 2450.1 FAIL    | 2083.1 FAIL                 | 2164.9 FAIL       | 2096.8 FAIL   |
| J1-deep.longTaskMs (1130) | 2122 FAIL      | 1757 FAIL                   | 1760 FAIL         | 1723 FAIL     |
| J1-deep.requests (246)    | 196            | 196                         | 196               | 196           |
| J1-deep.jsKB (4321)       | 3588.7         | 3588.7                      | 3588.4            | 3588.4        |

- Gates: web personal 0 (139 files, 1368), web tsc 0, server `src/personal` 0 (97 files, 1069), server tsc 0, contracts 0 (493), contracts tsc 0. Build exit 0.
- H7/H4/H1 re-proved on this code (h7race 0/8 wrong counts, count right from first render; H4 0 relay rows; H1 pass).
- Evidence `~/.personal-bots/qa/frontend-1593/` (`bisect.mjs`, `check-*.log`, probes: `probe-*.mjs`, `ws-*.json`, `profile-*.json`). Every throwaway stopped by its PID, roots deleted after junction checks. Bisect worktree `C:/Claude/AI/_wt/hbots-bisect` (detached, 1.30.1) left for reuse.
- Not done: J1 boot work itself. Profiling shows the boot runs a serial HTTP chain before the socket opens (version.txt, auth/session x2, client-diag, environment x2, link-state; about 1.3 s at 4x CPU) and most main-thread time is parse/compile/style ("program"). That is a bigger, separate job.

## 1.59.4: lighter boot, recalibrated J1 budgets

Staged, not activated: release `4db8bb035114` (on 1.59.3; live is 1.59.2 `c0ad253f2963`, the rollback; 1.59.3 `2a1b2f1ca439` was never shipped and is included). Web only on top of 1.59.3; no migration.

What the "serial chain" was: each boot call returns in about 6 ms; the gaps between them are main-thread work (module evaluation, ~1 s at 4x CPU before the first rows). Real duplicates: `/api/auth/session` (auth gate, then the Connect wizard's scope read), `/.well-known/t3/environment` (connection registration, then prepare), plus `/api/connect/link-state` from the wizard. `version.txt` is already fire-and-forget; the auth gate must precede the first render; the Clerk shell (a key is baked into the build, and relay auth needs it) is awaited before render by design. Those were left as they are. Auth, pairing and relay code paths are unchanged.

| Commit       | Change                                                                                                                                                                                    | Kill switch            | Before -> after (throwaway, 5 runs, 4x CPU)                                                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dcb6b2bc40` | Connect wizard: a light watcher keeps the sign-in transition logic; the wizard (session scopes + link state reads) mounts only when an in-session sign-in asks for it                     | `defer-connect-wizard` | J1-deep requests 196 -> 194; wall/long tasks noise                                                                                                                                          |
| `5f96e4a7e9` | Root dialogs and hosts (preview automation, Electron host, quit overlay, Connect/relay-install/SSH dialogs, theme editor) lazy, mounted by `DeferredMount` (>= 3 s after boot, then idle) | `lean-boot`            | J1-warm wall 1440.5 -> 1264.5, long tasks 1381 -> 1247, requests 145 -> 121, jsKB 2391 -> 2187.5; J1-deep requests 194 -> 178. Mounting them at first paint cost J2 403 ms, hence the delay |
| `f973d0b3cb` | A second descriptor read within 2 s reuses the first successful answer (web fetch wrapper; failures never reused)                                                                         | `descriptor-reuse`     | requests -1 (J1-warm 120, J1-deep 176); time within noise                                                                                                                                   |

Budgets (`b0bd35d4a5`, `d0169e4575`, CTO decision): the four J1 wall/longTaskMs ceilings reset once to 1.30.1's measured-today p50 (1834/1729, 2656/2202; repeat 1874.2/1851, 2641.2/2196), then ratcheted to 1.59.4's p50 x (1 + headroom) where lower: J1-warm.wall 1834 -> 1785; the other three stayed (candidates 1756, 3165, 2598 were higher). The seven other ceilings are untouched. README "Recalibration, 2026-09-30" and budget.json `recalibration` record it.

### Final 11-budget table (p50)

| Metric             | Old ceiling | New ceiling | QA live 1.59.2 | Throwaway 1.59.2, 400 chats | 1.59.4 gate (committed budget.json) | 1.59.4, 400 chats |
| ------------------ | ----------- | ----------- | -------------- | --------------------------- | ----------------------------------- | ----------------- |
| J1-warm.wall       | 1138        | 1785        | 1572.6         | 1386.1                      | 1269.7 ok                           | 1352.2            |
| J1-warm.longTaskMs | 960         | 1729        | 1521           | 1313                        | 1231 ok                             | 1231              |
| J1-warm.requests   | 196         | 196         | 145            | 145                         | 120 ok                              | 120               |
| J1-warm.jsKB       | 3632        | 3632        | 2390.7         | 2390.7                      | 2187.6 ok                           | 2187.6            |
| J2.chatShell       | 228         | 228         | 1133.1         | 567.5                       | 83.9 ok                             | 173.4             |
| J2.requests        | 4           | 4           | 50             | 50                          | 3 ok                                | 3                 |
| J2.jsKB            | 20          | 20          | 1198.2         | 1198.2                      | 0 ok                                | 0                 |
| J1-deep.wall       | 1478        | 2656        | 2450.1         | 2083.1                      | 2095.1 ok                           | 2094.4            |
| J1-deep.longTaskMs | 1130        | 2202        | 2122           | 1757                        | 1704 ok                             | 1730              |
| J1-deep.requests   | 246         | 246         | 196            | 196                         | 176 ok                              | 176               |
| J1-deep.jsKB       | 4321        | 4321        | 3588.7         | 3588.7                      | 3430.5 ok                           | 3430.5            |

`check.mjs` with the committed budget.json against the staged release: exit 0 (`~/.personal-bots/qa/frontend-1593/check-final1594.log`). Live data runs heavier than the throwaway (QA's 1.59.2 J1-deep long tasks were 2122 against the new 2202), so QA's live check is the one to watch.

- Gates: web `src/features/personal`, `src/lib`, `src/components/cloud` 0 (185 files, 1845 tests); web tsc 0; also `src/authBootstrap.test.ts`, `src/cloud`, `src/connection`, `src/environments`: 3 failures in `src/cloud/connectCliAuth.test.ts`, identical on untouched 1.59.0 (pre-existing, env-dependent). Server not touched since 1.59.3 (server personal 0, tsc 0 then). Build exit 0.
- H7 0/8 wrong counts, H4 0 relay rows, H1 pass, on the staged release. Deferred pieces load after about 3 s; the only console errors are the known Clerk `/v1/client` 400s.
- Every throwaway stopped by its PID, roots deleted after junction checks. Bisect worktree removed (`git worktree remove`, then `rmdir` with `\?\`).
