# hbots slow-connection pass (3G, Theo's method)

Base: `feat/hbots-16697` (live 1.66.97) at `872cbed458a5b075f666ddddc144904fbe4fc487`. Upstream main fetched at `dd5b5401e1f240f4314af29edf431369d182f386`. Branch: `perf/hbots-3g-load`.

## Method

`scripts/personal/perf/slow3g.mjs`: Brave, phone viewport 390x844, CDP throttling 400 kbps down and up with 400 ms RTT, cache disabled, a fresh profile and a new TCP connection every run, a byte-counting proxy in front of the server. Median of 3 runs. Throwaway servers on a copy of the backup data with schedulers off and fake providers; the live database was never opened or copied. Direct connection only: the relay was not measured (no isolated relay route for a throwaway). CDP charges WebSocket frames at their decoded size, so WebSocket-heavy journeys (reconnect) read slower than a real phone would; see `scripts/personal/perf/README.md`.

Reports: `~/.personal-bots/perf/slow3g-before.json` (1.66.97), `slow3g-after-shell.json`, `slow3g-after-all.json`. Budgets: `scripts/personal/perf/slow3g-budget.json`, checked by `slow3g-check.mjs`.

## Results (median of 3, direct)

| Journey                            | Metric      | 1.66.97 | after slim shell | pass 1 (43.5 s) |   final | change |
| ---------------------------------- | ----------- | ------: | ---------------: | --------------: | ------: | -----: |
| cold connect into the biggest chat | visible     |  59.4 s |           54.5 s |          43.5 s |  36.5 s |   -38% |
|                                    | wire        | 3293 KB |          3064 KB |         2342 KB | 1988 KB |   -40% |
|                                    | JSON parsed | 3765 KB |          1460 KB |         1244 KB |  823 KB |   -78% |
| reconnect (live Bots list)         | visible     |  21.2 s |           17.2 s |          17.1 s |   8.0 s |   -62% |
|                                    | wire        |  522 KB |           276 KB |          203 KB |  127 KB |   -76% |
|                                    | JSON parsed | 2985 KB |           786 KB |          778 KB |  357 KB |   -88% |
| open chat A                        | visible     |  4.28 s |           4.30 s |          2.28 s |  2.28 s |   -47% |
|                                    | wire        |  421 KB |           513 KB |          122 KB |  182 KB |   -57% |
| open chat B                        | visible     |  4.30 s |           5.34 s |          2.28 s |  2.25 s |   -48% |
|                                    | wire        |  543 KB |           686 KB |          303 KB |  362 KB |   -33% |
| open chat C                        | visible     |  3.27 s |           3.28 s |          2.27 s |  2.26 s |   -31% |
|                                    | wire        |  462 KB |           311 KB |          156 KB |  161 KB |   -65% |

Final report: `~/.personal-bots/perf/slow3g-split-trial.json`. On reconnect the cached Bots list (snapshot) is on screen at 1.1 s in every build; "visible" above is the live list. Open-chat wire is measured to settled (60 s cap): the KB before visible did not change for A and C (73 and 60 KB); the rise to settled is route warming for offline, which now starts after first paint and idle and so lands inside that window. Time to visible is unchanged.

Cold connect breakdown (final build, gzip): the chat deep link needs 198 scripts, 1231 KB (was 1279 KB; Shiki 61 KB swapped for a 11 KB hast-to-html chunk, Computer screen 28.5 KB off the path). With modulepreload hints the chat route chunks start at 0.6 s instead of 19.8 s, main.js finishes at 2.9 s instead of 4.8 s, and the last script lands at 31.6 s instead of 35.3 s. The remaining ~5 s to visible is the environment, shell and thread data chain. Theo's 89 KB cold figure upstream excludes JS; ours includes everything on the wire.

## Changes (one per commit, each with a kill switch)

| Commit                                   | Change                                                                                                                                                                                                                                                                                    | Switch                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `d0d686d3c0`                             | Connect-time shell leaves out idle archived bot chats (1,513 of 1,585 threads, 2.3 of 2.4 MB). A bot's chat list, an open archived chat and search load them on demand (`personalBots.threadShells`). Working or waiting archived chats stay in.                                          | `shell-omit-archived` (server `PB_PERF_OFF`, client `bots:perf-off`) |
| `699e2a0da1`                             | Chat snapshots drop tool updates that a completion at the same time supersedes.                                                                                                                                                                                                           | `tool-update-tie-dedup` (server)                                     |
| `394a97cbe7`                             | Chat opens send previews of finished reasoning (400 chars) and long tool commands (1,000 chars) outside the running turn; the classic timeline fetches the full text on expand (`personalBots.threadFullText`). The latest messages are complete and on screen at once.                   | `text-previews` (both)                                               |
| `686146da36`, `9447ebcf98`               | favicon.ico 284 KB to 104 KB and boot logo 114 KB to 36 KB (8-bit PNG frames, max pixel difference 0.34%), for the public and the served (blueprint) copies.                                                                                                                              | none (assets)                                                        |
| `43583185a1`                             | Browser trace exports are gzipped (were up to 231 KB uploaded per chat open); the server unzips with a 32 MB limit.                                                                                                                                                                       | `trace-gzip` (client)                                                |
| `bf4192a0be`                             | Fix: the composer skipped a destroyed tiptap editor. With the slim shell every classic chat open crashed ("Something went wrong"); found in the UI check, 3/3 before, 0/3 after.                                                                                                          | none (bug fix)                                                       |
| `fc9bd88839`, `e88835677e`, `4234796714` | Bench, detail timings, 3G budgets ratcheted from the after report.                                                                                                                                                                                                                        | n/a                                                                  |
| `0325226d53`                             | Web favicon: two browser requests 203.8 KB to 9.2 KB combined (48 px PNG frame, byte-identical to the ICO's); the double request is browser-initiated (link icon plus /favicon.ico), so both are small now. PWA icons stay in the manifest. Cold 43.5 to 40.4 s.                          | none (asset)                                                         |
| `adf1376100`                             | Route warming for offline starts only after first paint and idle (no time change claimed; it no longer competes with the first screen).                                                                                                                                                   | existing warming switch                                              |
| `d42893b06a`                             | `personalBots.list` leaves out archived chat links and sends a count per bot; a bot's chat list or an archived deep link fetches its own on demand (`omitArchived` request flag). Frame 999 to 96 KB; reconnect 17.1 to 7.9 s. An active chat's composer never waits for the list (test). | `archive-links` (client)                                             |
| `b40c91d7ed`                             | Splash logo is a 6 KB WebP (was the 36 KB apple-touch-icon PNG on every cold launch).                                                                                                                                                                                                     | none (asset)                                                         |
| `b687c870d9`                             | Shiki highlighter chunk (61 KB gzip) off a chat's startup path; only the 11 KB hast-to-html part loads with markdown.                                                                                                                                                                     | none (chunking)                                                      |
| `ceb7250fa5`                             | Side panel's Computer screen loads on demand (28.5 KB gzip off the chat path).                                                                                                                                                                                                            | none (lazy import)                                                   |
| `b33cb23f01`                             | index.html adds modulepreload for main's closure and for the opened page's route chunks only (chat, bot page or Bots list); chat route chunks start at 0.6 s instead of 19.8 s. Combined with the two above: cold 40.4 to 36.5 s.                                                         | `route-preload` (client)                                             |
| this commit                              | 3G budgets ratcheted from the final report (cold 47.9 to 40.3 s, reconnect 18.9 to 8.8 s and the KB ceilings).                                                                                                                                                                            | n/a                                                                  |

Compression: static assets and HTTP JSON go out brotli, the WebSocket uses permessage-deflate, trace uploads are now gzip. Over the relay: not measured.

## Upstream commits

All of these are built on orchestration v2, which the fork does not merge, so none was cherry-picked; ideas were adapted.

| Commit                                                               | Outcome                                                                                                                                                                            |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `67c3afbd58`, `e57c093cdd`                                           | Adapted as the slim shell (archived bot chats rather than subagent or older settled threads, since that is where the fork's bulk is).                                              |
| `553203c57b`                                                         | Adapted as text previews: long turns are bounded by trimming finished reasoning and long commands, not by dropping rows, so the 10-turn window and the latest messages stay whole. |
| `e19fe0837b`, `80455376f0`                                           | Partly adapted: the superseded tool updates are dropped server side. The wire-level body and id dedup needs a new encoding at both ends of the v2 contract and was skipped.        |
| `abd9d9f970`, `17dc1afa15`, `c7e3993fe9`, `d7a8d6f320`, `fd1063ba7c` | Not in scope (provider catalog already slimmed on personal paths, cache writes, v2 SQL, guarded resume, subagent streams).                                                         |

## Tried and rejected

- Merging small chunks (Rolldown `codeSplitting` groups, `entriesAware`): app-wide at 8 KB cut main to 13 requests but pulled `main.tsx` and route components into chunks the entry loads statically, so lazy code would run at startup. A node_modules-only group gave 96 main / 206 chat requests and 1308 KB at 8 KB, 1444 KB at 30 KB: more bytes, not fewer. 139 of the 200 cold scripts are under 3 KB; over HTTP/1.1 (bench) this costs bandwidth in two tail gaps, over the relay (h2) much less. Reverted.
- Lazy `rehype-raw` (about 60 KB): messages with HTML would flash raw markup first. Left as a follow-up.
- Data prefetch from index.html: requests are DPoP signed per connection; not safe to fire before the client is up.
- Classic and developer views, settings, Team, editor, terminal and diff are already split by route; none is in a chat's startup closure (checked against the manifest: only 1 to 2 KB route-definition stubs from the route tree remain).

## What is left

- Cold is now bound by the serial environment, shell and thread data chain (about 5 s after the last script) and by the small-script tail on HTTP/1.1.
- `personalRoutines.list` (113 KB) polls every 30 s by design (next-run times).
- Relay (h2) measurement needs an isolated relay route.
- Gates (NODE_ENV=test) match 1.66.97 test by test: web 11 and server 17 failures are the same tests on the base, including `asyncConsoleFile` (for Backend). Format (67 files) and lint (307 errors) findings are identical to the base.
