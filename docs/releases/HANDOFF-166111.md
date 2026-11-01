# 1.66.111: Android phase 0.5 server (client handshake and sliding phone sessions)

Based on 1.66.110 (`250fff68da`). Branch `release/hbots-166111`, built from `feat/hbots-android-p05` at `7f57d64a11`, which contains main. No migration; schema remains 114. Server only; `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

Harout, 1 Nov 2026: "Ship the server changes." The native Android client needs two things from the server before it can ship. It must learn the server version before it holds any credential, and a paired phone must stay signed in for as long as it is used. This release carries only the server half. The Android scaffold and the personal-client branch are not in it.

## What changed

- **Client handshake.** New anonymous `GET /api/personal/client-compat` returns `{serverVersion, android: {minimumNativeVersion}}`. `serverVersion` is read from the served `version.txt` and is `null` when the stamp is missing or not `x.y.z`. `minimumNativeVersion` is `1.66.110`. Responses carry `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. A bad or huge `version.txt` never fails the route.
- **One release-version reader.** `apps/server/src/personal/releaseVersion.ts` replaces three private copies of the same `version.txt` read (update status, the performance routes and the memory tidy service). Same regex, trim and null rules. Behaviour is unchanged.
- **Sliding phone sessions.** A phone paired directly with a one-time token (Bearer or DPoP) now gets a 30 day session that carries a `renewal: "sliding"` claim. It renews once `min(lifetime / 2, 1 day)` has passed since issue. Revoke and expiry still win. Cookie sessions slide exactly as before.
- **`POST /api/auth/session/renew`.** Returns a new token (or the same token with `expires_in` when it is not due yet). Bot, CLI, relay, desktop-bootstrap and dev tokens, and cookie sessions, get 403 `session_not_renewable`. Expired or revoked sessions get 401. A DPoP renewal needs a valid proof for the bound key.
- **Desktop and dev DPoP sessions stay at one hour.** Review finding R2: a first cut moved proof-bound desktop-bootstrap and dev-token sessions to 30 days. The fix commit `7f57d64a11` keeps them at the 1 hour fixed lifetime they had before.
- **Group resend.** A test pins the group resend dedupe. No code change.

## Rollback

Binary only. The previous release is `5a67a39f2a1e` (1.66.110). A token with the `renewal` claim decodes on the old code and works as a fixed session until its own `exp`; the verifier booted the old release against tokens minted on this one and all of them authenticated. `POST /api/auth/session/renew` answers 404 on the old code.

## Known and accepted

- Renewal mints a new token and the presented token stays valid to its own `exp`, so an old token can be renewed again. Revoking the session kills every token of it. Same model as cookies (Verifier R1, Low).
- `PersonalBrowser.test.ts` "keeps the card and the lease while another bot asks for the browser" flaked once in Verifier's full run under load. It passed 5 of 5 alone and in the rerun. The branch does not touch that code.

## Verification

- Auth work: red then green proofs in `/home/harout/Claude/AI/dev-team/qa/hbots-android-p05-auth/RESULTS.md`.
- Independent review and live throwaway (renew, DPoP, revoke, rollback, client-compat edge cases): PASS in `/home/harout/Claude/AI/dev-team/qa/hbots-android-p05-verify/RESULTS.md`, including the delta to `7f57d64a11`.
- Release gates for this exact commit are recorded below.
