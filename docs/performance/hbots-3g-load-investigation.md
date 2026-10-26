# hbots slow-connection pass (3G, Theo's method)

Base: `feat/hbots-16697` (live 1.66.97) at `872cbed458a5b075f666ddddc144904fbe4fc487`. Upstream main fetched at `dd5b5401e1f240f4314af29edf431369d182f386`. Branch: `perf/hbots-3g-load`.

## Method

`scripts/personal/perf/slow3g.mjs`: Brave, phone viewport 390x844, CDP throttling 400 kbps down and up with 400 ms RTT, cache disabled, a fresh profile and a new TCP connection every run, a byte-counting proxy in front of the server. Median of 3 runs. Throwaway servers on a copy of the backup data with schedulers off and fake providers; the live database was never opened or copied. Direct connection only: the relay was not measured (no isolated relay route for a throwaway). CDP charges WebSocket frames at their decoded size, so WebSocket-heavy journeys (reconnect) read slower than a real phone would; see `scripts/personal/perf/README.md`.

Reports: `~/.personal-bots/perf/slow3g-before.json` (1.66.97), `slow3g-after-shell.json`, `slow3g-after-all.json`. Budgets: `scripts/personal/perf/slow3g-budget.json`, checked by `slow3g-check.mjs`.

## Results (median of 3, direct)

| Journey                            | Metric      | 1.66.97 | after slim shell | after all | change |
| ---------------------------------- | ----------- | ------: | ---------------: | --------: | -----: |
| cold connect into the biggest chat | visible     |  59.4 s |           54.5 s |    43.5 s |   -27% |
|                                    | wire        | 3293 KB |          3064 KB |   2342 KB |   -29% |
|                                    | JSON parsed | 3765 KB |          1460 KB |   1244 KB |   -67% |
| reconnect (live Bots list)         | visible     |  21.2 s |           17.2 s |    17.1 s |   -19% |
|                                    | wire        |  522 KB |           276 KB |    203 KB |   -61% |
|                                    | JSON parsed | 2985 KB |           786 KB |    778 KB |   -74% |
| open chat A                        | visible     |  4.28 s |           4.30 s |    2.28 s |   -47% |
|                                    | wire        |  421 KB |           513 KB |    122 KB |   -71% |
|                                    | JSON parsed |  862 KB |           885 KB |    484 KB |   -44% |
| open chat B                        | visible     |  4.30 s |           5.34 s |    2.28 s |   -47% |
|                                    | wire        |  543 KB |           686 KB |    303 KB |   -44% |
|                                    | JSON parsed |  695 KB |           825 KB |    384 KB |   -45% |
| open chat C                        | visible     |  3.27 s |           3.28 s |    2.27 s |   -31% |
|                                    | wire        |  462 KB |           311 KB |    156 KB |   -66% |
|                                    | JSON parsed |  744 KB |           606 KB |    533 KB |   -28% |

On reconnect the cached Bots list (snapshot) is on screen at 1.1 s in every build; "visible" above is the live list.

## Changes (one per commit, each with a kill switch)

| Commit                                   | Change                                                                                                                                                                                                                                                                  | Switch                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `d0d686d3c0`                             | Connect-time shell leaves out idle archived bot chats (1,513 of 1,585 threads, 2.3 of 2.4 MB). A bot's chat list, an open archived chat and search load them on demand (`personalBots.threadShells`). Working or waiting archived chats stay in.                        | `shell-omit-archived` (server `PB_PERF_OFF`, client `bots:perf-off`) |
| `699e2a0da1`                             | Chat snapshots drop tool updates that a completion at the same time supersedes.                                                                                                                                                                                         | `tool-update-tie-dedup` (server)                                     |
| `394a97cbe7`                             | Chat opens send previews of finished reasoning (400 chars) and long tool commands (1,000 chars) outside the running turn; the classic timeline fetches the full text on expand (`personalBots.threadFullText`). The latest messages are complete and on screen at once. | `text-previews` (both)                                               |
| `686146da36`, `9447ebcf98`               | favicon.ico 284 KB to 104 KB and boot logo 114 KB to 36 KB (8-bit PNG frames, max pixel difference 0.34%), for the public and the served (blueprint) copies.                                                                                                            | none (assets)                                                        |
| `43583185a1`                             | Browser trace exports are gzipped (were up to 231 KB uploaded per chat open); the server unzips with a 32 MB limit.                                                                                                                                                     | `trace-gzip` (client)                                                |
| `bf4192a0be`                             | Fix: the composer skipped a destroyed tiptap editor. With the slim shell every classic chat open crashed ("Something went wrong"); found in the UI check, 3/3 before, 0/3 after.                                                                                        | none (bug fix)                                                       |
| `fc9bd88839`, `e88835677e`, `4234796714` | Bench, detail timings, 3G budgets ratcheted from the after report.                                                                                                                                                                                                      | n/a                                                                  |

Compression: static assets and HTTP JSON go out brotli, the WebSocket uses permessage-deflate, trace uploads are now gzip. Over the relay: not measured.

## Upstream commits

All of these are built on orchestration v2, which the fork does not merge, so none was cherry-picked; ideas were adapted.

| Commit                                                               | Outcome                                                                                                                                                                            |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `67c3afbd58`, `e57c093cdd`                                           | Adapted as the slim shell (archived bot chats rather than subagent or older settled threads, since that is where the fork's bulk is).                                              |
| `553203c57b`                                                         | Adapted as text previews: long turns are bounded by trimming finished reasoning and long commands, not by dropping rows, so the 10-turn window and the latest messages stay whole. |
| `e19fe0837b`, `80455376f0`                                           | Partly adapted: the superseded tool updates are dropped server side. The wire-level body and id dedup needs a new encoding at both ends of the v2 contract and was skipped.        |
| `abd9d9f970`, `17dc1afa15`, `c7e3993fe9`, `d7a8d6f320`, `fd1063ba7c` | Not in scope (provider catalog already slimmed on personal paths, cache writes, v2 SQL, guarded resume, subagent streams).                                                         |

## What is left

- `personalBots.list` is about 500 KB of JSON on every connect (1,702 links, 1,528 of them archived). Under the throttle it lands at 16.3 s and is the bulk of the reconnect time. Making archived links lazy touches about 22 client files; recommended next step.
- `personalRoutines.list` (113 KB) polls every 30 s by design (next-run times).
- The remaining cold upload is mostly request headers over about 150 HTTP/1.1 requests (inference).
- Relay measurement needs an isolated relay route.
