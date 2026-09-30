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
other seven ceilings were not touched. Numbers and logs: HANDOFF-1591.md and
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
