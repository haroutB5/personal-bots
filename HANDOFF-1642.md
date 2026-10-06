# HANDOFF: hbots 1.64.2 (6 Oct 2026)

Branch `fix/start-gap-1642` (off live main 04a1a73856 = 1.64.1). One server fix, no migration, no web change. Concurrency stays 5.
Staged with `build.ps1 -NoActivate -CopyExternals` (4 `.env` keys loaded, `externals=copied`), not active.

## Cause

`server.ts` binds the HTTP port as soon as `HttpServerLive` is built. Node's `http.Server` only gets the application's `request` and
`upgrade` listeners when `serve` runs, which is when the whole routes layer (migrations, provider registry, ...) is built, 0.4 to
1.5 s later. In between, the only listeners are the ones from `guardHttpResponseWriteErrors`; they observe a request to attach an
error handler and never answer it. So a request or WebSocket upgrade that lands in that window hangs, and stays hung after the server
is ready. After the handler is attached a request is queued by `commandReadinessLayer` and answered at ready (that part was fine).
It is not the relay: the managed tunnel starts after activation (command ready), so it never sees the window. The web client's
connect attempt has a 15 s timeout (`CONNECTION_ESTABLISHMENT_TIMEOUT`) and then a 1 to 2 s backoff, so a phone attempt that falls in
the window reconnects after about 18 to 20 s instead of about 2 s.

## Fix

`httpEarlyRequestHold.ts` (`holdEarlyRequestsUntilHandled`, wrapped around the guard in `HttpServerLive`): holds early `request` and
`upgrade` events and replays them to the first real handler as soon as it is attached (`newListener`, replay on `setImmediate`, once
both handlers exist). The port still binds early, so a second server on the same port still fails fast (that is why the listen was not
moved after the routes). Clients that gave up while held are dropped; a request held over 30 s gets a 503 with `Retry-After: 1` (so the
web client's retry handles a startup that never finishes). One info line when anything was replayed: "replayed requests held before the
routes were ready" `{ requests, upgrades }`. Held requests are then answered by the existing command-readiness middleware, at ready.
No kill switch: it is a pass-through once released, and the module is 30 lines of logic with tests.

## Numbers (evidence: `C:/Users/Ht/.personal-bots/qa/startgap1642/`, `ab/summary.json`, `e2e2-*.json`)

Probe A/B, 10 restarts each after a warm-up, interleaved, throwaway copy of the synthetic golden root, 1.64.1 (1e2d1a02d7a0) vs 1.64.2:

|                                                               | 1.64.1                          | 1.64.2                                                              |
| ------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------- |
| port open (median)                                            | 924 ms                          | 933 ms                                                              |
| first answered request, ready (median / max)                  | 1686 / 1963 ms                  | 1687 / 1822 ms                                                      |
| requests sent after port open, never answered                 | 146 of 3902 (10 of 10 restarts) | 0 of 1188                                                           |
| unanswered window (port open to last unanswered send, median) | 416 ms                          | none                                                                |
| longest wait of a held request (median per restart)           | n/a                             | 724 ms (answered at ready)                                          |
| phone model reconnect (30 per build): median / mean / max     | 1872 / 5316 / 19855 ms          | 1756 / 1848 / 2522 ms                                               |
| phone models that hit the window                              | 6 of 30 (18.1 to 19.9 s)        | 0 of 30                                                             |
| real Chrome opens the app 250 ms after port open              | 0 of 10 loaded in 25 s          | 10 of 10: document 1.72 s, authenticated `/ws` frame 3.0 s (median) |

The WS upgrade in the probe is unauthenticated (401 from the real handler); the Chrome run covers the authenticated upgrade (101 plus data).

## Not changed, worth knowing

The real client's own backoff dominates a phone's reconnect when a restart takes a few seconds: each failed attempt doubles the ceiling
(2, 4, 8, 16 s ... up to 5 min, delay in the upper half), so a client that has been failing for a while comes back long after the
server is ready. Seen on 1.64.2 itself, in one Chrome page restarted 10 times 5 s apart (so its failure count never reset): reconnect
3.8, 5.3, 14.8, 17.4, 52.3 and 10.6 s after the spawn, and 4 of 10 not back within 60 s, while the server was ready at 1.7 s every time.
Returning to the app skips the wait; a client that retries sooner while the server is known to be starting would be the lever. That is
client behaviour and a product decision, not changed here.

## Gates (exit codes)

server `vp test run src/personal src/mcp` plus the http/startup tests and the new `httpEarlyRequestHold.test.ts` (6 tests): exit 0
(163 files, 2284 passed, 4 skipped); server `tsc --noEmit` exit 0; `vp lint --report-unused-disable-directives` 0 errors in the changed files
(the repo's existing warnings are unchanged); `vp fmt --check` on the changed files exit 0.

## Risk notes for the QA tier

Small-fix tier (a contained server fix, no migration, no web change). The one place to look is the replay: it re-emits `request` and
`upgrade` on Node's server once, so a WebSocket upgrade held in the gap goes through the same auth path as any other (covered by the
Chrome run). Not covered: a real iPhone through the relay tunnel (the tunnel starts after ready, so the window cannot hit it).
