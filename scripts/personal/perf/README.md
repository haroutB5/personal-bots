# hbots perf bench

Measure first, change one thing, prove it with numbers, lock the win in.
This is the loop from Anthropic's "How we made claude.ai faster", applied to the
Bots PWA. The generic version of this loop is the `speedoptimiser` skill
(`scripts/personal/perf/skill/`, installed for every bot).

## One-time setup: a signed-in browser state

The bench runs in fresh, isolated browser contexts that are signed in from a
cookie file. The file is kept outside the repo in
`%USERPROFILE%\.personal-bots\perf\auth-<host>.json`.

```powershell
# local server (127.0.0.1:38472)
node <release>\dist\bin.mjs pair --ttl 10m --label perf-bench --base-dir %USERPROFILE%\.personal-bots\dev
node scripts/personal/perf/login.mjs "http://localhost:38472/pair#token=..."
# relay
node <release>\dist\bin.mjs pair --connect --ttl 10m --label perf-bench --base-dir %USERPROFILE%\.personal-bots\dev
node scripts/personal/perf/login.mjs "https://prod-...t3coderelay.com/pair#token=..."
```

## Journeys

Every run uses a new phone-sized context: 390x844 at DPR 3, touch, and a 4x
CPU throttle to stand in for an iPhone. The network is whatever the origin is:
`local` is the laptop, `relay` goes through T3 Connect.

| Journey   | Start -> end                                                               |
| --------- | -------------------------------------------------------------------------- |
| `J1-cold` | first visit to `/bots` (empty caches, no worker) -> first chat row painted |
| `J1-warm` | installed-PWA relaunch (worker + snapshot warm) -> first chat row painted  |
| `J2`      | tap a chat row on the list -> transcript and typeable composer painted     |
| `J1-deep` | warm relaunch straight into that chat (a notification tap) -> chat usable  |
| `J2-back` | Back arrow in that chat -> the list on screen again (opt-in, not gated)    |

`J2-back` runs only when asked for (`--journeys J1,J2,J2-back`), so the gate's
journeys are unchanged. Its mark (`listBack`) is the first frame at whose rAF the
chat header is gone and a bot row is in the page, read like `chatShell` because
the phone keeps the list mounted, hidden, under the chat (`keep-list`, 1.60.0).

J3 (send, echo, first token) comes from the RUM beacons (below), and also from
`stream.mjs --rum`. J4 (a long streamed reply with code blocks and a table) is
measured by `stream.mjs`, which opens a new chat, costs one model turn and deletes
the chat afterwards. J5 (server cold start) is `coldstart.mjs`, run against a
throwaway data root, never the live one.

For each journey the bench records:

- wall-clock to the mark;
- the page's own counters: React commits (through a devtools-hook stand-in),
  long tasks, layout shifts before and after the mark (with the region they
  hit), and the requests and JS bytes needed before the mark;
- CDP counters: script ms, task ms, layouts, style recalcs, heap;
- WebSocket frames and KB received before the mark.

## Commands

```powershell
node scripts/personal/perf/bench.mjs --origin local --runs 7 --bot Frontend
node scripts/personal/perf/bench.mjs --origin relay --runs 5 --bot Frontend
# A/B one optimization in the same build (runs alternate on/off):
node scripts/personal/perf/bench.mjs --origin local --runs 10 --bot Frontend --ab preload-chat
# A/B two builds on two throwaway servers (runs alternate A, B, A, B; journeys are filed as name@A / name@B;
# run it twice with the servers swapped to cancel the order effect, the second slot is slower by 50 to 90 ms):
node scripts/personal/perf/bench.mjs --origins http://127.0.0.1:A,http://127.0.0.1:B --runs 20 --journeys J1,J2
# which counters track wall-clock:
node scripts/personal/perf/correlate.mjs %USERPROFILE%\.personal-bots\perf\bench-*.json
# the gate (exit 1 on a regression) and the ratchet:
node scripts/personal/perf/check.mjs
node scripts/personal/perf/check.mjs --ratchet
# or: pnpm perf:check
# J4 streaming (add --off warm-highlighter for the A side, --profile 1 for a CPU profile):
node scripts/personal/perf/stream.mjs --origin local
# J5 server cold start, with and without NODE_COMPILE_CACHE:
node scripts/personal/perf/coldstart.mjs --runs 5
# real-user timings from the phone:
node scripts/personal/perf/rum.mjs --days 7
# the in-app journeys bench.mjs does not walk (list scroll, Team, Tasks, Scheduled, Computer, a long chat, send):
node scripts/personal/perf/journeys.mjs --origin http://127.0.0.1:38711 --runs 7 --long /bots/<bot>/<thread>
node scripts/personal/perf/journeys.mjs --origin <url> --journeys team --runs 12 --ab layout-once
# the phone and the server while bots work (5 streaming turns, Bots list open):
node scripts/personal/perf/churn.mjs --origin <url> --seconds 25 --server-pid <pid> [--off activity-memo]
# the committed gate against a throwaway server:
node scripts/personal/perf/check.mjs --origin <url> --bot Researcher
```

Before measuring, check the machine: the bench prints CPU busy % and free
memory. The macOS VirtualBox VM, Windows Update and bots at work all move
wall-clock by 2x. Compare only A/B runs that were interleaved, or runs taken
back to back.

## Which metrics gate

`correlate.mjs` pools runs and reports, for each counter, its Pearson r with
wall and its run-to-run spread (cv). The first baseline (2026-09-23, local,
23 runs per journey) gave:

- J1-cold/J1-warm/J1-deep: `longTaskMs`, `scriptMs` and `longTasks` track wall
  (r 0.6-0.8). The journey is CPU-bound on the page.
- J2: no client counter tracks wall. J2 wall is dominated by the server's thread
  snapshot, which is 1-9 s on a long-running server process and about 20 ms on
  a fresh one. `chatShell` (tap -> chat header) is the client part.
- `requests`, `jsKB` and `commits` are deterministic (cv ~0). They cannot
  correlate run to run; they are judged across builds, and they moved with wall
  in every accepted change.

`budget.json` therefore gates wall p50 with headroom (machine noise), plus
deterministic counters with tight headroom and an absolute `slack`. Budgets only
move down: `--ratchet` lowers a beaten budget to p75 x (1 + headroom), using p75
so that one quick run cannot set a budget the next ordinary run fails. Each
lowering is committed with the change that earned it.

**Recalibration, 2026-09-30 (1.59.4).** The one exception to "only down". The
four J1 wall and long-task ceilings came from 1.30.1 on 2026-09-23, and by
2026-09-30 1.30.1 itself missed them on this laptop: with the same bench (5 runs
plus a warm-up, 4x CPU, 390x844, a throwaway server with the fake Claude CLI),
1.30.1 measured J1-warm wall/longTaskMs 1834.5/1729 and J1-deep 2655.9/2202
(a repeat: 1874.2/1851 and 2641.2/2196). A bisect across 1.53.1, 1.57.2, 1.57.3,
1.58.1, 1.59.0, 1.59.1 and 1.59.2 found no regression; every one was faster than
1.30.1. The machine and Chrome moved, not the code. By CTO decision those four
ceilings were reset once to 1.30.1's measured-today p50, then ratcheted as usual
(p50 x (1 + headroom), by CTO decision for this step) against 1.59.4; the
other seven ceilings were not touched. Numbers and logs: docs/releases/HANDOFF-1591.md and
`~/.personal-bots/qa/frontend-1593/`.

**J2.chatShell fix and recalibration, 2026-09-30 (1.59.5).** The probe stamps
each mark with the rAF time of the frame whose post-paint check first sees
the element. A tap's click task can run between that rAF and the check, so the
chat header it inserts (painted in the next frame) was stamped with the
earlier frame, sometimes before the tap was handled: the same build read
120-200 ms or 325-385 ms at random. `chatShell` now requires the header to be in
the DOM at a frame's rAF and marks that frame (other marks unchanged). The 228
ms ceiling had been set with the old reading, so it was recalibrated like the
J1 ones: 1.30.1 re-measured with the fixed probe on the same live-shaped
synthetic data (seed.mjs; 20 bots, 391 chats, 16.2k messages) gave p50 630.2
and 682.2 ms; the ceiling was reset once to 630, then ratcheted to 1.59.5's p50
132.3 ms x 1.4 = 185. The other ten ceilings were not touched.

**J2.chatShell re-ratchet from a median, 2026-09-30 (CTO decision).** 185 came
from one 1.59.5 reading (132.3), and chatShell is bimodal per run, so 1.59.5
itself failed it about half the time. Ratchets come from a stable median: the
committed gate ran 5 times on 1.59.5 (`bf1e6cebf0c4`) and 5 times on 1.60.0
(`47f1670e01f9`), interleaved, on the same live-shaped synthetic data, each run
started only with the CPU under 12% and no build, test or bench running, and
re-done when it was loaded at its start or end. Per-run chatShell p50 (ms):
1.59.5 196.8, 186.0, 147.4, 169.3, 159.2 (median 169.3); 1.60.0 287.6, 128.1,
248.5, 189.2, 154.9 (median 189.2). 1.60.0's median is not lower, so the
ceiling is 1.59.5's median x 1.4 = 237. The other ten ceilings are unchanged.
Evidence: `~/.personal-bots/qa/frontend-160/calib.json`, `calib.log`,
`check-cal-*.log`.

## Kill switches

Every optimization that changes when work happens is on by default and can be
turned off on one device, with no release:
`localStorage.setItem("bots:perf-off", "preload-chat,rum")`. The flag names live
in `apps/web/src/features/personal/perfFlags.ts`. The bench's `--off` and `--ab`
set the same key.

Server-side optimizations are switched off in the server's environment, then a
restart: `PB_PERF_OFF=session-prewarm` (comma-separated, names in
`apps/server/src/personal/perfFlags.ts`).

| Server flag       | What it does                                                                                                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-prewarm` | Opening a bot chat (or bringing it back to the foreground) starts its Claude session in the background, with no prompt and no turn, so the next send skips the session start. At most 3 prewarmed sessions sit unused at once (~240 MB each); the reaper stops idle ones after 30 minutes.                              |
| `task-summaries`  | `personalTasks.subscribe` replays unfinished tasks plus the newest 20 finished ones as summaries (no objective or acceptance/expected-output text, a 600-character result preview). Off: the old replay of up to 200 finished tasks with full text. Older tasks come from `personalTasks.history`/`related` either way. |

## Send prep (session prewarm)

`prewarm.mjs` measures the server's prep for a send: `thread.turn-start-requested`
to the first `thread.session-set` with status `running`, read from the event log
of a throwaway server (never the live one; each run costs one tiny model turn).

```powershell
node <build>\dist\bin.mjs serve --base-dir %TEMP%\pb-prewarm --no-browser --port 38591
node <build>\dist\bin.mjs pair --ttl 10m --label perf-bench --base-dir %TEMP%\pb-prewarm
node scripts/personal/perf/login.mjs "http://localhost:38591/pair#token=..."
# a first turn in a new chat:
node scripts/personal/perf/prewarm.mjs --origin http://localhost:38591 --db %TEMP%\pb-prewarm\userdata\state.sqlite
# a chat whose session is gone: restart the throwaway server, then
node scripts/personal/perf/prewarm.mjs ... --chat /bots/<bot>/<thread>
```

## RUM

`apps/web/src/features/personal/perfRum.ts` sends one beacon per journey from the
real client: `j1`, `j1-chat`, `j2`, `j3-echo`, `j3-first`. Each beacon carries ms
and says whether the page was warm (service-worker controlled) and whether it
came via the relay or direct. The beacons go to `POST /api/personal/client-diag`,
which is allowlisted and rate limited. They land in the server log as
`client-diag {"event":"perf",...}`, and `rum.mjs` summarises them.

## 1.64.1: the Bots list while bots work, and what else was measured (6 Oct 2026)

Rig: a throwaway data root built once from synthetic data (20 bots, 390 chats of which 258 archived,
16.2k messages; `qa/perf1641/seed-golden.mjs`, the fake Claude CLI), a fresh copy per measurement, one
server per side, runs interleaved, 390x844 at DPR 3, 4x CPU. Never the live root. The tools and every
raw result are in `C:/Users/Ht/.personal-bots/qa/perf1641/` (`RESULT.md` there is the index).

**The one big offender.** With the Bots list open and five bots streaming, the phone's main thread was
saturated: 19.3 s of long tasks in a 25 s window, frames at p95 214 ms, 127 frames over 100 ms.
A CPU profile (sourcemaps, `symbolize.mjs`) put a third of it in `buildBotSummaries`: it sorted each
bot's chats with a comparator that parsed five date strings twice per comparison, and it rebuilt on
every shell update. `churn.mjs` is that scenario as a number.

| Change (commit)                                                             | Measured, same build on/off or old/new build, fresh servers, interleaved                                                                                                                                 | Kill switch        |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Activity read once per shell, memoised, decorated sort (3cb80245b2)         | long tasks 19595 -> 6760 ms (-65%), script 699 -> 372 ms/s, frame p95 196 -> 88 ms, frames over 100 ms 140 -> 24 (4 pairs); J1-warm liveRows 4062 -> 3795 ms, J1-cold liveRows 2813 -> 2613 ms (6 pairs) | `activity-memo`    |
| Open links grouped per bot once (63e3ce696b)                                | long tasks 6826 -> 5731 ms (-16%), script 329 -> 292 ms/s (4 pairs, previous build vs this one)                                                                                                          | `activity-memo`    |
| Team: each candidate layout measured once (3cb80245b2)                      | Team long tasks 831 -> 652 ms, script 791 -> 608 ms (6 pairs), wall unchanged                                                                                                                            | `layout-once`      |
| One `Intl.DateTimeFormat` per zone, bounded preview-line cache (3cb80245b2) | about 1% of the phone's main thread in the streaming profile each; no isolated A/B                                                                                                                       | none (pure caches) |

Final release against 1.64.0, 8 interleaved runs each (`qa/perf1641/final/summary.txt`): J1-warm liveRows
4224 -> 3746 ms (-11%), J1-warm wall 1846 -> 1604 ms, J1-cold liveRows 2956 -> 2609 ms, Team long tasks
807 -> 623 ms and script 1134 -> 715 ms, J2-back 148 -> 128 ms; everything else within noise (J2.chatShell
251 -> 270 ms is inside the run-to-run spread). Streaming scenario, final vs 1.64.0 (4 pairs): long tasks
19344 -> 5347 ms (-72%), script 683 -> 293 ms/s (-57%), frame p95 214 -> 71 ms, frames over 100 ms 127 -> 21.

**Measured and left alone (numbers for the next pass).**

- _Avatar animations._ Five working bots cost the phone's page about 250 ms/s of main thread (unthrottled,
  Chrome headless and headed): the 30 running CSS animations are restyled about 115 times a second. Pausing
  `working-pill` and `working-body` halves that; all five flags off (`all-busy-motion`, `anim-all`,
  `anim-comet`, `anim-thought`) takes the list from 414 to 105 ms/s. Not changed: it is the product look, and
  it is Chrome, not the iPhone. Next step: A/B `bots:perf-off=all-busy-motion,anim-all` on the phone.
- _A long single turn._ One turn with 400 replies (p99 of the real data: 146, max 338) takes 15 s to open
  at 4x and 17 s of script to scroll; turn paging (10 user turns) does not help a single huge turn.
  A chat of 100 ordinary turns (450 messages) shows 40 messages and its post-open long tasks are 2.5 s, mostly
  Shiki highlighting run in render (`UncachedShikiCodeBlock`).
- _Payloads._ `personalBots.list` is 121 KB (107 KB of it the 390 chat links, 258 archived) and costs the
  server 41 ms and the phone about 450 ms of schema decode at 4x; `subscribeShell` is 540 KB.
- _Server._ Startup: port open at 1.0 s, first answered request at 1.85 s (n=5); a request in that gap is never
  answered (cause not found), and NODE_COMPILE_CACHE saves only 160 ms. Under five streams the server
  runs at 40 to 60% of a core, `sql.transaction` p50 4.5 ms (raw SQLite NORMAL is 0.02 ms: the time is
  Effect and tracing around about 13 statements per command), request ping p50 20 ms, p95 40 to 70 ms.
  `T3CODE_TRACE_MIN_LEVEL=Error` cut server CPU 61 -> 50% and ping p95 71 -> 56 ms (3 pairs) but drops the
  span traces the team reads, so it is not the default. RSS plateaus at about 520 to 620 MB after 12 bursts
  (about 19 hours of live-sized traffic), 240 to 380 MB idle: no leak.
- _Gate._ The committed `perf:check` fails J2.chatShell (ceiling 237) on 1.64.0 itself on this rig
  (p50 309 and 316) and on 1.64.1 (277 to 282); J1-warm.wall (1785) sits at its edge on both. Only the four
  deterministic counters were ratcheted (see `budget.json`); no ceiling was loosened.

## 1.64.2: the start gap (6 Oct 2026)

`startgap.mjs <release> <throwaway root under the temp folder> <port> [runs] [out.json]` spawns a server and, from before the
spawn, sends an HTTP GET and a `/ws` upgrade every 50 ms plus three phone-model clients (the web client's 15 s attempt
timeout and its 1 s base backoff ladder). It reports the port-open time, the first answered request, how many requests sent
after the port opened were never answered, and each phone model's reconnect time.

Finding on 1.64.1 (10 restarts, synthetic 300 MB root): the port opens at about 0.92 s and the routes are ready at about
1.69 s. Requests that arrive in the first ~0.4 s (until the request handler is attached) are never answered, not even after the
server is ready; the rest wait and are answered at ready. 146 of 3902 requests sent after port open were never answered, in 10
of 10 restarts. 6 of 30 phone models hit it and reconnected after 18.1 to 19.9 s (15 s attempt timeout, then the backoff).
A real Chrome that opens the app 250 ms after the port opens did not load it in 25 s, 10 of 10. 1.64.2 holds early requests and
replays them to the handler: 0 of 1188 unanswered, no phone model above 2.5 s, Chrome loads the app and connects `/ws` at a median
3.0 s. Startup itself is unchanged (ready median 1686 vs 1687 ms). See `docs/releases/HANDOFF-1642.md`.

## 1.66.0: what the warm open really loads, and why no JS was cut (7 Oct 2026)

Brief: cut the warm journey's JS (2.26 MB, 123 requests) by lazy-loading the screens most opens do not need, target under
1.2 MB, ratchet the budget. Rig: the committed bench (J1/J2, 390x844 at DPR 3, 4x CPU) against throwaway servers from
`scripts/personal/throwaway-server.ps1` with the fake CLI and four seeded chats (the golden-root numbers match: J1-warm 2256.4 KB,
123 requests). Tools and every raw result are in `C:/Users/Ht/.personal-bots/qa/frontend-1660/` (`warmlist.mjs` lists the scripts
before the mark, `coverage.mjs` runs block coverage over the warm open, `attrib.mjs` attributes output bytes to packages through
the sourcemaps, `swapn.sh` is the interleaved A/B below).

**Finding 1: no screen is in the warm open.** The chunk list of J1-warm has no Computer, Team, Memory, Routines, Files, Passwords,
Settings or avatar-video code (they are route-split since 1.59.x). The 2.26 MB in 118 requests is the framework floor. Output bytes
by package before the list shows (2,130 KB attributed): effect 275, react-dom 174, @base-ui 156 (menu, tooltip, toast),
client-runtime ~200, contracts ~150, @clerk 125 (plus two scripts and two calls to `clerk.t3.codes` on every launch, which no counter
sees), TanStack router and query ~100, lucide and Icons 128, theme palette (culori) 77, composerDraftStore and what it drags (trait
picker, model selection) ~70, tailwind-merge 28, about 300 KB of app code. Block coverage: 1,050 of the 2,255 KB run before the mark;
the rest is loaded and never executed there (base-ui 116, effect 107, react-dom 72, Icons 61, Clerk 64, composerDraftStore 41).
88 of the 118 requests are chunks under 6 KB (182 KB in all). Under 1.2 MB would mean dropping effect, the contracts schemas or
Clerk from the first load: no lazy screen gets there.

**Finding 2: cutting bytes made the notification-tap journey slower.** Two cuts were built and measured:

| Change                                                                                                 | Counters (exact)                                                                                            | Wall clock, interleaved on one server                                                                                            |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `__root`: the provider-update popover loads only off the Bots routes (it never renders on them)        | J1-warm 2256.4 -> 2156.8 KB, 123 -> 120 requests (Icons chunk 78.7 KB, its logic 8.3 KB, 11.8 KB of `main`) | J1-warm unchanged (rows 1361 vs 1347 ms, n=20); **J1-deep +300 ms** in the bench (n=10, every round), +87 ms in a reused browser |
| `ConversationSidePanel`: the Computer screen inside the wide-desktop panel loads when the panel mounts | J1-deep 3586.8 -> 3508.5 KB, 181 -> 179 requests                                                            | **J1-deep +124 ms** (2554 vs 2430 and 2431 ms, n=10, every run above the others' median)                                         |

A third try (moving the whole side panel out of the chat chunk, with its element id in `desktopColumns`) added a shared chunk to the
Bots list's critical path: J1-warm rows +70 to 85 ms. Nothing shipped: J1-deep has a 2656 ms ceiling and these builds sit at
2550 to 2740. The method matters: one server, the builds swapped under it by renaming the client folder between runs, one bench run
per Chrome, a control build of the unchanged source (`ctl`: J1-warm 1448 vs 1443 ms, J1-deep 2415 vs 2378, so the build chain adds
nothing) and a control of the same code with different bytes (`v7`: 2326 vs 2368, so a changed file is not what slows it).
Two servers compared with each other differ by up to 300 ms on identical builds, and the second slot of a run pair is 50 to 90 ms
slower, so never compare builds on two servers or in one fixed order. Why removing code slows the deep link is not found: the extra
time is many short tasks (taskMs +150 to 200, long tasks unchanged), and it appears only with a fresh Chrome per run, not in a reused
one. The suspects are idle-scheduled work that now starts before the chat mark; a trace of J1-deep on `ctl` against `v4` would settle it.

**Tried and dropped**: taking `composerDraftStore` out of the first load (reached through `lib/utils`, `toast` and the environment
cleanup) saves 65 to 108 KB but rolldown then splits its shared chunk into 27 base-ui pieces (+27 requests, the budget would rise); a
rolldown group for base-ui pulled the whole chat into the first load (3.7 MB); a group to fold the 88 tiny chunks together broke module
order (`initialConfigValueAtom` of undefined) and needs `strictExecutionOrder`; `treeshake.moduleSideEffects: false` for the workspace
packages saved 21 KB and risks dropping side-effect imports; blocking Clerk's CDN scripts did not change J1-warm wall (n=10 each);
deferring the theme engine (77 KB) risks a theme flash.

**Open for a decision, not done:** skip the Clerk provider on the Bots routes. The phone never signs in to T3 Connect; it is about
127 KB counted, two cross-origin scripts, two calls and a 400 per launch (blocking them cut script time 5% and post-mark long tasks 10%),
and every launch tells `clerk.t3.codes`. It is one chunk reached only by a dynamic import in `main.tsx`, so it does not reshuffle the
chunk graph. Budgets are unchanged: with no JS cut there is nothing to ratchet.

## 1.66.3: Bots launches boot without Clerk (7 Oct 2026)

Brief: cut the warm open's JavaScript (2.26 MB, 123 requests at 1.66.1) and decide whether Clerk has to load on the Bots routes.
Rig: one throwaway server (`throwaway-server.ps1`, the 1.66.1 `dist`, the fake CLI, four seeded chats), the web client folder swapped under
it between runs (one bench run per Chrome, builds in rotation, an identical-code control), 390x844 at DPR 3, 4x CPU, laptop 4 to 25% busy
at the start of each run. Tools and every raw result: `C:/Users/Ht/.personal-bots/qa/fastopen/` (`swap.sh`, `summ.mjs`, `pool.mjs`,
`clerkproof.mjs`, `deepab.mjs`, `deepprof.mjs`). `bench.mjs` now also counts requests to other origins (`extRequests`, `extKB`, from CDP):
resource timing hides their sizes, which is why Clerk's CDN scripts and calls never showed in `requests` and `jsKB`.

**The change: `skip-clerk`.** A browser launch on a Bots path (`/bots`, `/tasks`, `/computer`, `/files`) does not load or mount the Clerk
shell. Nothing in the Bots shell reads Clerk: the phone signs in with a pairing link and a session cookie. The decision is `cloud/managedAuthBoot.ts`
and rides on `PROVIDER_WORKSPACE_DATA_OMITTED`, whose only exits from the shell (Developer view, Answer in Developer view) already reload
the document, so settings, the welcome wizard, `/connect` and the T3 Connect screens boot with Clerk as before. The root onboarding dialog is not
mounted when Clerk is skipped. Kill switch (phone, no release): `localStorage bots:perf-off=skip-clerk`.

| Median, 1.66.1 -> this build (p75 in brackets) | 1.66.1 (42 runs) | skip-clerk (26 runs) |
| ---------------------------------------------- | ---------------- | -------------------- |
| J1-cold: wall                                  | 2690 (3159) ms   | 2507 (2729) ms       |
| J1-cold: requests, JS                          | 134, 2423 KB     | 122, 2131 KB         |
| J1-cold: requests to other origins             | 4 (127.3 KB)     | 0                    |
| J1-warm: wall                                  | 1504 (1648) ms   | 1539 (1626) ms       |
| J1-warm: requests, JS                          | 123, 2261.0 KB   | 120, 2130.9 KB       |
| J1-warm: requests to other origins             | 2                | 0                    |
| J1-deep (notification tap): wall               | 2531 (2725) ms   | 2547 (2839) ms       |
| J1-deep: requests, JS                          | 182, 3601.6 KB   | 178, 3471.5 KB       |
| J1-deep: requests to other origins             | 2                | 0                    |
| J2 (chat open): wall, chatShell                | 950, 110 ms      | 950, 107 ms          |

Requests and JS bytes are exact (no spread across runs). Wall clock is inside the run-to-run noise: the same 1.66.1 code measured against itself
differs by up to 200 ms between two 8-run sets. Cold open is faster in 18 of 26 same-round pairs (median -60 ms), warm +28 ms (noise), chat open -6 ms.
Notification open: the 26 full-bench pairs read +90 ms (slower in 19 of 26), but a dedicated J1-deep-only test of 30 interleaved pairs reads
2438 -> 2475 ms p50, paired median +12 ms, faster in 15 of 30, so no regression is shown; watch it. The local rig understates the gain: the bench's
Clerk fetches go over the laptop's fast line, the phone's go through the relay.

**Proof Clerk is still there where it is needed** (`clerkproof.mjs`, own Chrome contexts, dark, a throwaway server, 1.66.1 and this build run
through the same script):

- Pairing: a fresh browser opened on `/bots` is sent to `/pair`; the one-time link signs it in (session cookie set), lands on `/bots` with the chat list,
  and a reload keeps it signed in. Same on 1.66.1. The `/pair` document itself still loads Clerk (a launch off the Bots paths).
- With the build on a signed-in phone context, `/bots`, a chat, `/bots/team`, `/bots/settings`, `/tasks`, `/computer`, `/files` all render with 0 requests
  to other origins and 0 page or console errors (1.66.1: 15 requests to `clerk.t3.codes` and a Clerk 400 on the console).
- `/settings/connections` and `/settings`: `window.Clerk` present and the same 6 requests to `clerk.t3.codes` as 1.66.1. Developer view from
  `/bots/settings` reloads the document and Clerk loads. `bots:perf-off=skip-clerk` brings Clerk back on `/bots`.
- Not proved: a real T3 Connect sign-in. On `127.0.0.1` the Clerk instance answers 400 and "Sign in to T3 Connect" never renders, on 1.66.1 too,
  and a real sign-in needs Harout's account. The relay is a proxy to the same server and client origin, so relay pairing is the pairing flow above.

**Tried and dropped.**

- The provider-update popover loaded only off the Bots routes (`ProviderUpdateLaunchNotification`, the Icons chunk): JS 2131 -> 2031 KB, requests 120 -> 117, but
  10 interleaved rounds against the Clerk-only build read J1-deep 2502 -> 2601 ms, J1-cold 2449 -> 2620 ms, J2.chatShell 119 -> 148 ms. The same finding as 1.66.0.
  Reverted, not committed.
- A CPU profile of J1-deep on 1.66.1 and this build (8 pairs, 0.5 ms sampling) shows no single chunk behind a difference; it is spread thin.
- Everything dropped in the 1.66.0 section above stays dropped.
- Not tried: taking `jose`, the relay client and `composerDraftStore` out of the first load (about 55 + 46 KB, entangled with the connection layer and
  the chunk graph that 1.66.0 found fragile) and the theme engine (77 KB, flash risk).

**Gate.** `budget.json` is lowered to the new exact counters (J1-warm requests 126 -> 124, jsKB 2289 -> 2195; J1-deep requests 185 -> 183, jsKB 3642 -> 3576)
and gets a budget of 0 for requests to other origins on J1-cold, J1-warm and J1-deep. No wall or long-task ceiling was touched. On this laptop in this session
the committed gate fails the J1-deep ceilings (2656 ms, 2202 ms) on the 1.66.1 build itself too (p50 2781 and 3086 ms for 1.66.1 against 3097 and 3293 ms for this
build, in the same alternating runs, with the laptop shared with other builds), and passed on both builds in the third pair (2650 and 2625 ms).
