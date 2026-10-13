# HANDOFF 1.67.0

The whole hbots redesign in one release, as Harout asked (13 Oct): the Bots home, the chat's new look, Team in
design A, the bot form's name-and-look-first layout, safe model defaults, a push when a plain chat waits on you, and
the home's speed work. It carries everything live 1.66.39 has (the Performance tab, the sliding browser sessions and
the scrub fix), and it adds one fix QA found on live: every bot's CLI now groups under its own name in the
Performance tab. Another fix answers QA's own run on the staged 1.67.0 (13 Oct, NO-SHIP): the needs-input push and
in-app notice now deep link to the request card itself (`?request=`), which they did not before. The other failure in that
run, the update line, was the check racing the server's 5 s update-status cache, not an app bug: `UpdateStatusLine.tsx`
and `updateStatus.ts` are byte-identical to live and 1.66.36 behaved the same way, so Frontend's branch adds a
component test and no source change. What QA should look at is at the end.

Three branches, each gated on its own, merged here by Backend:

- `feat/hbots-1670-core` - the server and non-home parts (`aedc4282bc`..`f24c321521`): model defaults, the bot form's
  name and look, Team in design A, `chat_needs_input`, the machine-wide pending-sign-in RPC, model family names.
- `feat/hbots-1670-home` - the home redesign (Frontend, `4987343057`..`fc79302a60`) plus IT's speed work
  (`0e54d51ff6`..`af239879cd`): the windowed list, lighter avatars, the kept list's scroll and Back, each change
  behind its own `bots:perf-off` switch.
- `feat/hbots-1671-chat` - the chat's look (Frontend, `ea97f6a7fd`..`a51a4fe1c7`), with IT's dock fixes and the
  live 1.66.39 merge already in it. It called itself 1.67.1; this release is **1.67.0** and the version file says so.

Branch `release/hbots-1670`: the core merge (`3572011cdd`), the home merge (`c94b01588b`), the sign-in count fix
(`071a8ec5b0`), the version bump (`c586c1b845`), then the merge of `origin/release/hbots-16638` (the sliding
sessions, `4f0459795d`), the merge of IT's `origin/feat/hbots-1670-home` at `af239879cd` (`e06d0fca0a`), the merge of
the live `origin/release/hbots-16639` (`3d6591faf6`), the Performance attribution fix (`b5340741fc`), the phone
smoke's own update (`8d8cf31ff3`), the merge of `origin/feat/hbots-1671-chat` at `a51a4fe1c7` (`6d85f58642`), and
then QA's run on the staged build: the needs-input deep-link fix (`3b6ccbf148`), the merge of Frontend's
`origin/fix/hbots-1670-version-line` at `bd02e08f54` (`120767e5b8`, a component test and no source change), and the
notes (`5153173b52`).

No conflict changed a behaviour. `personal.css` was the only shared file both sides changed, and every side was
purely additive (the redesign and chat tokens on one side, IT's `--perf-*` tokens and the live-dot keyframes on the
other), so all of it was kept; `scripts/personal/app-version.txt` was the only real conflict (1.67.0 against the chat
branch's 1.67.1) and it keeps 1.67.0. Checked after the merge that all three survive: IT's windowing
(`home-window`, `home-window-compact`) and the Back fix (`home-back-layout`, `KeptBotsHome`, `useHomeWindow`), and
Frontend's dock (`DockedQuestion`, `WorkingProgressRow`) and `?request=` landing (`requestLanding.ts`), the last two
wired into `ConversationScreen` and green in the web gate.

Migration max **106 -> 106** (no new migration). `PERSONAL_TASKS_CONCURRENCY = 5` unchanged, as every release must
keep it.

## What ships

**The Bots home** (Frontend). The tab bar says Bots with the needs-you badge, the home leads with the rail of pinned
and recent chats, the filter chips (All, Needs you, Unread, Groups), the chat rows and their pills, and a slim usage
line. Back from any chat returns to `/bots` with the filter kept; from the Team screen it returns to `/team`. The
sign-in count on the home reads the machine-wide pending list, so a sign-in in a plain chat counts too.

**Team in design A** (core, `3aaf2bb9dc`). The constellation is the design's fixed ring, the lead crowned at the
centre with "team lead" in its accessible name, every label on a surface plate so the orbit never crosses text, a
member's name wrapping to two lines so "Release Notes Copywriter" stays whole, captions in the app's own words
(`botStatus`) with the model and effort when idle, an amber ring on a bot waiting on you, and the header's
`N bots · Move` button opening the members sheet. The handoff spokes and their legend are gone; the delegation
counts, the Working now card and the move flow are unchanged. A caption names a known model by its family
(`Haiku 5.5`), never a raw slug (`f24c321521`), and never repeats the effort when the model's own name ends with it
(`8541625586`).

**Safe model defaults** (core, `aedc4282bc`). One shared rule (`packages/contracts/personalBotModelDefaults.ts`)
backs the server seed and the form's create, provider switch and fallback picker: Opus 5.5 first, the provider's own
default next when it is not one of the three expensive tiers, else the first current model (Codex: GPT-6.1 Sol after
Astra). Fable, Mythos and Astra are never picked automatically; all three stay pickable by hand. OpenCode still
names no default, so the form still asks.

**The bot form** (core, `e8ec2d18a4`). Name and the avatar picker come first, the look beside the name with a
Shuffle button, the shape and colour grids under a Look fieldset. A new bot takes a shape+colour pair no other bot
wears, walking all 84 palette combinations before reusing the least-worn one; the owner's own pick always wins, and
an edit never touches a saved bot's look.

**`chat_needs_input`** (core, `9bbc90a363`; deep link fixed in `3b6ccbf148`). A question or a tool approval in the
owner's own chat with a bot now notifies: title `<Bot> · <chat title>`, body `Needs your answer: ...` or
`Needs approval: ...`, a deep link to the chat, one push per request, suppressed while that chat is open, riding the
needs-input preference. A sign-in or secret request parks the turn's caller task and sends the same chat
notification instead of the task page one. Task, routine and group chats keep their own notifications. The
integration tests drive the real event order (`runtimeEventToActivities` wrapped in the
`thread.activity-appended` event the decider publishes).

The deep link opens the chat **at that request**: `/bots/<bot>/<thread>?request=<id>`, which is what the route's
`?request=` landing (Frontend's `requestLanding.ts`, D13) needs to scroll to the card and wash it. It carries the
provider's own request id for a question or an approval and the request row's `request_id` for a sign-in or a secret
(`pendingChatRequest` reads it beside the label); a request the provider gave no id for keeps the bare chat link,
because the transcript drops a card with no id and `?request=` would then name nothing. The push and the in-app
notice are built from the same payload, so a tap on either lands on the card. QA's check found this the other way
round: the notice showed and its tap opened the chat, but nothing in the url named the request.

**`personalLoginRequestsListPending`** (core, `b10ab82d59`). One RPC, no input: every pending or filling sign-in
request across all chats, same item shape and read scope as the per-thread list, metadata only. The home's needs-you
heuristic uses it at merge time, so sign-ins in plain chats count.

**The home's speed work** (IT). Every change is on by default and can be turned off on one device with
`localStorage.setItem("bots:perf-off", "<name>[,<name>]")`:

- `home-window`, `home-window-compact` - the home draws only the rows near the scroll position, standing in for the
  rest with spacers, over a smaller row buffer.
- `home-avatar-idle`, `home-avatar-image`, `home-avatar-memo` - a quiet avatar drops three animation wrappers,
  renders identical artwork as one SVG image (54 fewer nodes) where no theme halo is needed, and skips a render when
  its props have not changed.
- `home-row-memo`, `home-rail-memo` - a row, a rail card or a tile renders again only when a field it draws changed.
- `home-rail-edge-dom` - the rail's scroll-edge fade is written to the scroller's own attribute, so crossing an edge
  no longer renders every card.
- `home-filter-defer` - a chip tap or a search key updates the chip or the field at once and the rows in
  time-sliced work (`useDeferredValue`).
- `home-stage-mount` - on a first launch with nothing saved, the rail and the first rows mount in a few steps of a
  few dozen nodes instead of one 500-node commit.
- `home-scroll-restore` - Back restores the kept list's scroll before paint, after the route's DOM writes.
- `home-back-layout` - the hidden home keeps its layout while Activity pauses its effects, instead of the
  `display:none` path (unsupported browsers fall back to it).

Two fixes ride with them: an off-screen avatar stops animating, thinking pose included (the pause rule lost the
cascade to the pose rules' `animation` shorthand; measured on the QA fixture, 12 swipes at 4x CPU, 3 interleaved
rounds: **35.5 fps / frame p95 36.3 ms / 1,070 ms long-task** against **33 fps / 36.6 ms / 1,799 ms** as shipped),
and settings dividers no longer invalidate their siblings.

**Carried from live 1.66.39**, unchanged: the Computer > Performance tab with the scrub fix (a gap reads "Not
measured"), and the sliding browser sessions (a paired phone stays signed in while it is used). No staged branch can
undo either.

**The Performance tab's bot grouping** (this branch, `b5340741fc`). QA's read-only live check of 1.66.39 found the
tab never grouped the bots: the hbots card read "3 bots busy · 5 tasks running" while "Bots 0 processes" and the
CLIs counted under "hbots server". The tab attributed a CLI by matching `--session-id`/`--resume` against
`projection_thread_sessions.provider_session_id`, which is empty in all 1,042 live rows. The session id a chat
resumes lives in `provider_session_runtime.resume_cursor_json` instead, so the query now reads that table and the
attribution reads the id out of the cursor with the same helper the Token usage table uses. A Codex app-server names
nothing on its command line, so its spawn site records the PID under the chat
(`provider/botProviderProcesses`, keyed by chat, a resumed session replacing the process it left behind) and the tab
matches that PID and its whole subtree; a Claude CLI registers the same way. Chrome keeps its own group.

Proven on the live machine's own shapes, read-only, through the shipped rule: the **5 live provider CLIs (4 Claude,
1 Codex) attribute to QA, IT, Frontend, CTO and Backend; before the fix, 0 of 5**. The tests use the real command
lines and the real `resume_cursor_json` rows for each provider rather than the throwaway's fake CLI, which is how
the bug reached live QA. A throwaway with the fake CLI was re-checked after the change: the pane opens at 390 px
dark, 0 page errors, `hbots: server 0.2 GB · bots 0.0 GB · browser 0.0 GB`, which is right for a root with no real
provider processes.

**The chat's new look** (Frontend, `feat/hbots-1671-chat`; full story in `qa/hbots-1670/frontend/REPORT-1671.md`).
The header is two rows: back, the avatar button (tap = Edit bot), the name over its state caption in the state's own
colour ("Working", "Thinking", "Needs you", the model when idle), then "…"; under it the chip strip, 32 px pills in
44 px bands with the open chat filled, "+ New" outlined, and a fade that swaps side once scrolled. The thread reads in
runs: bubbles for the owner and short plain replies, full-width replies (with a sender row) for anything carrying a
list, table, code, steps or a card, one time per run (the swipe still gives every message's exact time), and a
question another device answered becomes a centred receipt. The dock: a 56 px progress row with the running turn's
latest real step and "Working · 4m 12s" ticking, folding away when the turn ends, and the docked question, whose
options are 48 px rows, or one sideways row of 44 px chips while the keyboard is up, with a step dot per question and
drafts kept per request. A multi-select set keeps its Send answer; a fast double tap sends one answer. `?request=<id>`
lands a chat on that request card (paged into the window if it sits above it, washed for 1.4 s, no long animated
scroll), and a chat opened with no param lands on its own newest open request, which is how the home's pills land on
the request with no home change and no server change. The dock tap bug (an option's own focus was read as "the field
lost focus", so the dock swapped layout under a finger already down and the answer never went) was found at the
pointer level and fixed (`1887aae78f`, `a51a4fe1c7`), and it is why the smoke's `question` journey is measurable
again.

The chat's speed, measured by Frontend under the lock, 5 interleaved pairs against 1.66.36 both fixtures seeded
alike (`qa/hbots-1670/qa/results/compare-fe1671base-vs-fe1671cand-2026-10-13T14-56-17`): equal or better on every
metric of `longChat`, `railScroll`, `listScroll`, `filter` and `type`; DOM nodes are higher where the redesign adds
UI (cold 797 against 602, open chat 1,367 against 1,026, Team 1,243 against 969) and `question` is a little slower to
paint (wall 135.3 against 117.6 ms, long tasks 747 against 628 ms) because the journey now actually answers the
question. The list remounted on Back in 0 of 5 runs, so the structural rule holds.

**The phone smoke follows the new home** (`8d8cf31ff3`). The suite waited on the search field's own label to mean
"the Bots screen is up", which every build before 1.67.0 rendered always; the redesign shows that field only once
the header's button opens it, and a fresh root has no chat rows yet, so the smoke now waits on the screen's own
heading and the one journey that searches opens the field through the header button first. Tapping a bot on the
list now opens its screen (the bots are the rail's tiles) rather than the name sheet in place, so the two journeys
that start a chat from the list press that screen's New chat button, and the tab bar's first link is named Bots,
not Chats, in the six places `offlineNetwork` taps it. Run against the staged release: **12/12 journeys in 242 s**
(9 of 12 before the change). The long-press journey presses again when the menu has not opened (up to three times,
the assertion unchanged): a long press is timing-sensitive, and on this laptop a re-render while the finger is down
cancels it. It passes alone and in the suite after that; before it, the full suite failed that one journey twice in
a row while the same five journeys in the same order passed on their own.

## Proof

- Fork gates on the merged branch, and the build, evidence and e2e: the gate table below.
- The home and Team functional checks (IT, `qa/hbots-1670/qa/results/checks-it1670final-*`): filters, the Back rule
  from an arrow, an edge swipe, browser Back and a deep link, the kept list's scroll, 44 px targets with no sideways
  page scroll, the desktop layout, and 0 uncaught page errors.
- The home's speed: the per-change A/B sheets (`qa/hbots-1670/perfit/ab-*.md`, `ab-all-*.md`) and QA's interleaved
  A/B pairs (`qa/hbots-1670/qa/results/compare-*`), which is the comparison to trust on this shared laptop. The
  first cut of the home was worse than 1.66.36 on DOM nodes, list-scroll fps and the long tasks of opening a chat;
  the windowed list and the lighter avatars are IT's answer to exactly those numbers, each behind its own switch.
- The attribution fix: the live-shape proof above, its unit tests, and the throwaway re-check.
- The needs-input deep link: the server tests drive the real event order and assert the whole stored payload
  (`?request=` for a question, an approval, a sign-in and a secret; the bare chat link for a request with no id),
  the page plan and the banner tap have their own tests, and the end-to-end proof is a throwaway server on the
  staged release: the in-app notice for an off-screen question was tapped and landed on
  `/bots/personal-seed-planner/<thread>?request=<id>` with the question on screen
  (`qa/hbots-1670/backend/probe-push-deeplink.mjs`, and QA's own `push-in-app-deep-link` check PASS on
  `qa/hbots-1670/qa/results/checks-b1670fix-*`). The check as QA re-wrote it (visible matches only) also passed on
  the _previous_ staged build, so it is the probe and the server tests that prove the query string, not the check
  alone.
- QA's live 1.66.39 check (`qa/live16639-readonly/VERDICT.md`) is where the grouping bug was found; QA's final pass
  on this staged release is the 10-pair interleaved compare and the 32 checks, and its proof goes in below.

## What to watch live

- The phone: the home's first paint and the list scroll (the windowed list), Back from a chat keeping the filter and
  the scroll, and the Team screen's ring and captions when a bot is waiting on you.
- A chat question: one push, deep-linked to the chat at the request itself, nothing while the chat is open.
- The Performance tab: each busy bot's CLI under its own name in "hbots on this PC", with its shell commands and
  builds inside it, and Chrome still its own group.

## What QA should look at

- Performance tab, live or staged: with several bots busy (a Claude bot and a Codex bot at least), "hbots on this
  PC" names each bot with its processes, the sums of server + bots + browser match the card above, and "Heaviest
  right now" has bot rows; the sort by CPU and by Memory. Then a bot stops: its row goes with it.
- The home at 390 px dark: the rail, the filter chips, the rows and pills, the needs-you badge, and Back from a chat
  to `/bots` with the filter kept; Team from `/bots/team` back to `/bots/team`.
- Team in design A: a 9-bot team with a long name ("Release Notes Copywriter"), the crown on the lead, the model
  and effort when idle, the amber ring on a bot waiting on you, and the N bots · Move sheet.
- The bot form: a new bot takes a look no other bot wears, name and look first, and an edit leaves a saved bot's
  look alone.
- A question in a plain chat: exactly one push, none while the chat is open, and the tap opening the chat **at the
  question** (`/bots/<bot>/<thread>?request=<id>`) - the in-app notice and the push click both, including with the
  app already open on another screen, and Back from there landing on `/bots`.
- The chat's own look on the phone: the header's chips, the thread's runs and full-width replies, and above all the
  dock, where a tap on an answer must land (that is the bug Frontend fixed at the pointer level: tap an option with
  the keyboard up and with it down, and answer a multi-select set); `?request=` from a home pill lands on the request
  card, washed, and a chat with no param lands on its newest open request.

## Gate evidence

<!-- gate-evidence:begin sha=5153173b52b9434d92b63b63f1d32ae4aa93735e release=5153173b52b9 json-sha256=99548149a4202c41cbda02b018a5a079ff1127d03905e0eb017e2e18cc7e7726 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-13T19:05:42Z. Version 1.67.0, release `5153173b52b9`, commit `5153173b52b9434d92b63b63f1d32ae4aa93735e` on `release/hbots-1670`, working tree clean, result **PASS**.

Machine-readable copy: `releases\5153173b52b9\gate-evidence.json` (sha256 `99548149a4202c41cbda02b018a5a079ff1127d03905e0eb017e2e18cc7e7726`) and the full gate logs in `releases\5153173b52b9\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2583 tests passed, 0 failed, 3 skipped, in 188 files | 228.8   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 30      |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2704 tests passed, 0 failed, 0 skipped, in 252 files | 33.9    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 5       |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 58.6    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-1670-core\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\5153173b52b9" -Json` (in `.`)                                                                                                                 | 0    | pass: 12/12 journeys passed                                | 266.2   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `5153173b52b9434d92b63b63f1d32ae4aa93735e`, at end `5153173b52b9434d92b63b63f1d32ae4aa93735e`; tracked files modified: none. Staged release: version 1.67.0, sha 5153173b52b9, dirty False, externals copied; `dist/bin.mjs` sha256 `30980bd38c47426f4024640bbce3f9d3f361d4c70b1ced0890e688c675baf0be`.
<!-- gate-evidence:end -->
