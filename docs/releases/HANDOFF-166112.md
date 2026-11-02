# 1.66.112: Session revoke route and hard close

Based on 1.66.111 (`b314d80ae129`). Branch `release/hbots-166112`, built from `feat/hbots-revoke-streams` at `2ea5f14ea4`, which merges `personal-bots/main` at `d26a26220a`. No migration; schema remains 114. Server only; `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

A stolen session token could keep desktop control, browser input, terminal writes and device hub requests alive. This release gives a session a way to revoke itself without a cookie and makes every authenticated stream close when that happens.

## What changed

- **`POST /api/auth/session/revoke`.** A non-cookie session revokes itself and gets `200 {revoked:true}`. A cookie session gets `403 session_not_revocable`.
- **Hard close on revoke.** A revoked session's `/ws`, desktop stream, browser stream and device hub WebSocket get close code `4401 session_revoked`. The server stops handling their messages at once. It destroys the TCP link after a 750 ms grace, so a client that ignores the close frame loses its channel within about 754 ms.
- **Device hub HTTP.** A response with no `Content-Length` (mjpeg, avcc, event log) ends on revoke. A fixed-length body is allowed to finish, because its length is bounded and auth was checked at the start.
- **In-flight work.** Queued input is dropped. A terminal write is one synchronous call, so it applies fully or not at all.

## Rollback

Binary only. The previous release is `b314d80ae129` (1.66.111). No migration ran.

## Known and accepted

- A `/ws` RPC handler already running at revoke can run for up to the 750 ms grace. A plain TCP drop interrupts it at once. No new input reaches it.
- A desktop button-down in flight when control ends stays pressed. Any socket close or TCP drop takes the same path. This is not caused by this change.
- The performance SSE stream is not ended on revoke.
- The web client does not treat close 4401 as signed out.
- `server.test.ts` "reports thread HTTP and WebSocket transfer budgets" fails on live code too. It is not in the release gate set. The gate covers `src/auth`, `src/personal`, `src/device`, `src/mcp`, `src/persistence`, `src/preview`, `src/workspace` and `src/assets`.

## Verification

- Builder red and green proofs: `/home/harout/Claude/AI/dev-team/qa/hbots-revoke-streams/RESULTS.md`.
- Independent review, round 2 PASS at `2ea5f14ea4`: `/home/harout/Claude/AI/dev-team/qa/hbots-revoke-streams-verify/RESULTS.md`.
- Release gates for this exact commit are recorded below.

## Gate evidence

<!-- gate-evidence:begin sha=5976c25dadcc9935fef440f7aa5375d62d34840f release=5976c25dadcc json-sha256=d47c1325d72573e71e481b12bbc3d5289b925d0c68ce979f4fb4e2e31303f083 result=PASS -->

- server-tests: PASS, exit 0
- server-tsc: PASS, exit 0
- web-tests: PASS, exit 0
- web-tsc: PASS, exit 0
- e2e: PASS, exit 0

<!-- gate-evidence:end -->
