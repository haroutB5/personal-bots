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

## Kill switches

Every optimization that changes when work happens is on by default and can be
turned off on one device, with no release:
`localStorage.setItem("bots:perf-off", "preload-chat,rum")`. The flag names live
in `apps/web/src/features/personal/perfFlags.ts`. The bench's `--off` and `--ab`
set the same key.

## RUM

`apps/web/src/features/personal/perfRum.ts` sends one beacon per journey from the
real client: `j1`, `j1-chat`, `j2`, `j3-echo`, `j3-first`. Each beacon carries ms
and says whether the page was warm (service-worker controlled) and whether it
came via the relay or direct. The beacons go to `POST /api/personal/client-diag`,
which is allowlisted and rate limited. They land in the server log as
`client-diag {"event":"perf",...}`, and `rum.mjs` summarises them.
