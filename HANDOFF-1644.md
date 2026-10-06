# HANDOFF: hbots 1.64.4 (6 Oct 2026)

Branch `fix/reconnect-backoff` (off 1.64.3, 93a9bcc5a8). Three commits: the client reconnect ladder, two research-tool fixes, this version bump and note.
No migration, no server change for the reconnect. Concurrency stays 5.
Staged with `build.ps1 -NoActivate -CopyExternals` (4 `.env` keys loaded, `externals=copied`), not active.

## Cause

A connected web client that loses its server (a hbots restart) retries with a ceiling that doubled 2, 4, 8 ... up to 5 min, the delay a random point in
the upper half of it (`retryDelayMs` in `packages/client-runtime/src/connection/supervisor.ts`). A restart takes 5 to 60 s plus about 1.7 s of startup, so the
client is somewhere on the ladder when the server comes back: after 60 s down it has tried at about 1.5, 4.5, 10, 22 and 46 s and the next try is at
about 94 s. Measured on 1.64.3 (below): 28 s median and 39 s worst for a 60 s restart, and 123 s after a 5 min outage. Nothing else was slow: the
descriptor fetch and the socket answer in under a second once the server is up, and an attempt that lands in the startup window is held and answered at
ready (1.64.2).

## Change

The ceiling is 2 s for the first retry, then holds at 4 s (delay 2 to 4 s) for 40 retries, about two minutes, and only then doubles from 8 s up to the
same 5 min cap. Jitter (upper half of the ceiling) is kept. The 30 s "stable connection resets the ladder" rule, the immediate retry on
visibilitychange / pageshow (probe or reconnect on mobile), on `online`, on an explicit retry and on a failed wake probe are unchanged; those already
skip the wait, so no new event listeners were needed. `focus` was not added: on the phone it fires together with visibilitychange and would double the probe.
The 15 s attempt timeout is unchanged: no measured run had a hung attempt (the 1.64.2 hold removed the only source), and a shorter limit would cut off
a slow but working connect over the relay.

Options not taken: a separate readiness probe before the socket. Every attempt already begins with `GET /.well-known/t3/environment` (the descriptor
fetch, 10 s limit) before it opens the socket, so that probe exists and costs one small request per try.

## Numbers (evidence: `C:/Users/Ht/.personal-bots/qa/reconnect1644/`, `rc-base-*.json`, `rc-cand-*.json`, `summ.mjs`)

Rig: `reconnect.mjs`, one headless Chrome page (390x844, signed in, service worker in control) stays open on `/bots` while a throwaway server (fake Claude,
synthetic root) is stopped for N s and respawned; 10 runs per downtime, 33 s between runs so the ladder resets; the three downtimes ran in parallel on
three throwaway roots, base and candidate under the same conditions. Lag = first authenticated `/ws` frame minus the moment `/.well-known/t3/environment`
answered 200. Base = release 93a9bcc5a89e (1.64.3), candidate = this branch.

| server down | 1.64.3 median / p90 / max | 1.64.4 median / p90 / max | not back within 150 s |
| ----------- | ------------------------- | ------------------------- | --------------------- |
| 5 s         | 4726 / 6237 / 7227 ms     | 159 / 1915 / 2379 ms      | 0 / 0                 |
| 20 s        | 3853 / 8049 / 13476 ms    | 1702 / 2189 / 2550 ms     | 0 / 0                 |
| 60 s        | 28373 / 38158 / 38891 ms  | 1581 / 2913 / 3369 ms     | 0 / 0                 |

Request rate against a server that stays down 5 min (one run each, requests are the page's descriptor fetches):

|                              | 1.64.3          | 1.64.4                                                                                |
| ---------------------------- | --------------- | ------------------------------------------------------------------------------------- |
| attempts in 300 s            | 7 (1.4 per min) | 44 (8.8 per min; about 20 per min in the first 2 min, then 8 s, 16 s, 32 s ... apart) |
| lag after the server is back | 123 s           | 6.0 s                                                                                 |

Each attempt against a dead local server is one refused connection. Through the relay it is one request that the relay edge answers with an error.

## Relay path (T3 Connect)

Not measured: it needs Harout's relay account, and a throwaway root has none. The supervisor is the same code for the same-origin page and the relay
(the relay differs only in `prepare`, which authorizes and fetches the descriptor through the tunnel URL), so the ladder change applies identically.
Two things differ and are not helped by this change: the managed tunnel starts after the server is ready, so on the relay "ready" is a few seconds later
than on a direct connection, and the phone retries every 2 to 4 s until then.

## Two research-tool fixes (QA 1.64.3, M1 and M2)

- M1: `search_web` passed `country` straight to Tavily, which rejects ISO codes ("UK") with HTTP 400. `tavilyCountry` maps common codes and aliases
  (uk, gb, us, usa, uae, fr, de, ... 60 of them) to Tavily's names, passes Tavily's own names through (case and spacing tolerant) and drops an unknown
  country so the search runs worldwide instead of failing. SerpAPI's `gl` is untouched (it wants the 2-letter code).
- M2: a call Tavily served with no earlier Parallel failure logged `fallbackReason: undefined`; the field is now left out.

## Seen while measuring, not changed

If a lazy chunk fails to load while the server is down, the page reloads once (`chunkReloadGuard`, then it is served by the service worker) and recovers
through the boot path, which polls `/api/auth/session` every 500 ms: that path was already fast (0.2 to 0.5 s after ready). A page without a service
worker lands on the browser's own error page and only Chrome's auto-reload (1 s, 5 s, 30 s) brings it back; Backend's earlier "not back in 60 s" rows may have included those
(not checked). A phone with the installed PWA has the worker.
The 5 min cap after the fast phase is unchanged: a server down for more than two minutes is retried every 4 to 8 s, then 8 to 16 s, and so on up to 5 min,
so a client that stays on screen through a long outage can take up to a few minutes after it is back unless the user switches apps or taps retry.

## Gates (exit codes, logs in the evidence folder)

web `vp test run --project unit src/features/personal` exit 0 (175 files, 1770 passed); client-runtime `vp test run` exit 0 (98 files, 1688 passed, supervisor
file 46 incl. the new ladder tests); server `vp test run src/personal src/mcp` exit 0 (154 files, 2037 passed, 3 skipped); `tsc --noEmit` exit 0 in
apps/web, apps/server and packages/client-runtime; `vp lint --report-unused-disable-directives` and `vp fmt --check` exit 0 on the changed files.

## Risk note for the QA tier

Small-fix tier: a client-only retry delay table, a country-name map and a logging field. No migration, no server change, nothing on login, memory or sends.
What to look at if QA wants one check: the supervisor ladder tests (`supervisor.test.ts`, "retryDelayMs" and "retries forever ...") and one run of
`reconnect.mjs` against the staged release. The web bundle changes, so open phones pick it up through the normal stale-release reload.
