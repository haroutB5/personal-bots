# HANDOFF: hbots 1.66.3 (7 Oct 2026)

Branch `perf/hbots-fastopen` (off main 953595f9b6 = 1.66.2). Frontend. Web change plus perf tooling, no server change, no migration. Concurrency stays 5.
Staged with `build.ps1 -CopyExternals` (4 `.env` keys loaded, `externals=copied`), not active.

## What changed

**1. The Bots app boots without Clerk (`skip-clerk`).** A browser launch on `/bots`, `/tasks`, `/computer` or `/files` no longer loads or mounts the
Clerk (T3 Connect sign-in) shell: no `@clerk` chunk, no clerk-js from Clerk's CDN, no calls to `clerk.t3.codes` on every launch. The phone signs in
with a pairing link and a session cookie, and nothing in the Bots shell reads Clerk. `cloud/managedAuthBoot.ts` decides once at boot from the launch
URL, using `PROVIDER_WORKSPACE_DATA_OMITTED` (true for exactly a non-Electron launch on a Bots path). The only ways out of the Bots shell (Developer view,
Answer in Developer view) already reload the document, so settings, the welcome wizard, `/connect` and the T3 Connect screens boot with Clerk as
before. The root onboarding dialog (a Clerk consumer) is not mounted when Clerk is skipped. Kill switch on the phone, no release:
`localStorage bots:perf-off=skip-clerk`. Files: `main.tsx`, `routes/__root.tsx`, `cloud/managedAuthBoot.ts` (+ test), `features/personal/perfFlags.ts`.

**2. Perf tooling.** `bench.mjs` counts requests to other origins (`extRequests`, `extKB`, from CDP), which resource timing hides. `budget.json` is lowered
to the new exact counters and gets a budget of 0 for requests to other origins on J1-cold, J1-warm and J1-deep. Perf README section "1.66.3".

## Numbers

One throwaway server (1.66.1 `dist`, fake CLI, four seeded chats), the web client swapped under it between runs, runs in rotation with an identical-code
control, 390x844 at DPR 3, 4x CPU, laptop 4 to 25% busy at each run start (QA and builds shared it part of the time, so wall clock is read as medians of
interleaved runs). 42 runs of 1.66.1, 26 of this build. Raw results and tools: `C:/Users/Ht/.personal-bots/qa/fastopen/`.

| Median (p75), 1.66.1 -> 1.66.3       | 1.66.1         | 1.66.3         |
| ------------------------------------ | -------------- | -------------- |
| Cold open: wall                      | 2690 (3159) ms | 2507 (2729) ms |
| Cold open: requests, JS              | 134, 2423 KB   | 122, 2131 KB   |
| Cold open: requests to other origins | 4 (127.3 KB)   | 0              |
| Warm open: wall                      | 1504 (1648) ms | 1539 (1626) ms |
| Warm open: requests, JS              | 123, 2261.0 KB | 120, 2130.9 KB |
| Warm open: requests to other origins | 2              | 0              |
| Notification open: wall              | 2531 (2725) ms | 2547 (2839) ms |
| Notification open: requests, JS      | 182, 3601.6 KB | 178, 3471.5 KB |
| Notification open: other origins     | 2              | 0              |
| Chat open: wall, chat header         | 950, 110 ms    | 950, 107 ms    |

Requests and JS bytes are exact in every run. Wall clock is inside run-to-run noise (1.66.1 against its own copy differs by up to 200 ms between two
8-run sets). Cold open is faster in 18 of 26 same-round pairs (median -60 ms). Notification open: the 26 full-bench pairs read +90 ms (slower in 19 of 26),
but a dedicated notification-open-only test of 30 interleaved pairs reads 2438 -> 2475 ms p50, paired median +12 ms, faster in 15 of 30. So no regression
is shown, and it is the one number QA should watch. The laptop understates the gain: the removed fetches cross the internet and, on the phone, the relay.

## Clerk decision and proof

Done, with the kill switch. Proof (`qa/fastopen/clerkproof.mjs`, own Chrome contexts, dark, throwaway server, 1.66.1 and 1.66.3 through the same script):

- Pairing: a fresh browser on `/bots` is sent to `/pair`; the one-time link signs it in (session cookie set) and lands on `/bots` with the list; a reload stays
  signed in. Same on 1.66.1.
- Signed in on a phone context, `/bots`, a chat, `/bots/team`, `/bots/settings`, `/tasks`, `/computer` and `/files` all render with 0 requests to other origins
  and 0 page or console errors (1.66.1: 15 requests to `clerk.t3.codes` and one Clerk 400 console error).
- `/settings/connections` and `/settings` still load Clerk (`window.Clerk` present, the same 6 requests as 1.66.1). Developer view from `/bots/settings` reloads
  the document and Clerk loads. `bots:perf-off=skip-clerk` brings Clerk back on `/bots`.

## Tried and dropped

- Provider update popover loaded only off the Bots routes: -100 KB and -3 requests, but 10 interleaved rounds read notification open +99 ms (2502 -> 2601),
  cold open +171 ms, chat header +29 ms against the Clerk-only build. Same finding as 1.66.0. Reverted, not committed.
- CPU profile of the notification open on 1.66.1 and 1.66.3 (8 pairs): no single chunk behind a difference.
- Not tried: `jose`, the relay client and `composerDraftStore` out of the first load (entangled with the connection layer and the fragile chunk graph),
  the theme engine (flash risk). The 1.66.0 drops stay dropped.

## Staged release proof (29500ddf78a5, throwaway server, fake CLI, laptop 5% busy)

- `perf:check` (the committed gate, 5 runs, 4x CPU, no ratchet) passed: warm open 1365.5 ms (ceiling 1785), notification open 2349 ms (2656), chat header 107.2 ms (237),
  requests 120 / 178 against 124 / 183, JS 2130.9 / 3471.5 KB against 2195 / 3576 KB, requests to other origins 0 on cold, warm and notification open.
- The Clerk proof script on the staged build: pairing and reload ok (3 chats listed), every Bots screen renders with 0 requests to other origins, settings and Developer
  view load Clerk, the kill switch brings it back. The only console errors on `/bots` were one 429 from the throwaway server's own rate limiter after the
  script's burst of pairing and session calls; three clean loads afterwards showed no 4xx or 5xx.
- Release gates: see "Gate evidence" below (server 2304 tests, web 2064, both tsc, 233 PowerShell checks, e2e 5/5).

## Not tested / limits

- A real T3 Connect sign-in: on `127.0.0.1` the Clerk instance answers 400 and the sign-in button never renders, on 1.66.1 too, and a real sign-in needs
  Harout's account. The relay proxies the same origin, so relay pairing is the pairing flow above; a physical iPhone was not used.
- The committed gate's J1-deep ceilings (2656 ms, 2202 ms) fail on the 1.66.1 build itself on this laptop in this session (p50 2781 and 3086 ms) and on
  1.66.3 (3097 and 3293 ms) in the same alternating runs, and pass on both in the third pair (2650 and 2625 ms). No wall ceiling was changed.

## For QA

Small change (one boot decision), so a focused check: phone pairing link on a throwaway server, then `/bots`, a chat, Team, Settings, Tasks, Computer,
Files with the browser console open (expect no Clerk request, no errors); `/settings/connections` on desktop (Clerk present); Developer view and back;
notification-open timing (one tap on a chat link from a cold app) on the real phone.

## Gate evidence

<!-- gate-evidence:begin sha=29500ddf78a56dfa40ec393c48db3f57702eb0ad release=29500ddf78a5 json-sha256=9625cf102910cb0e0e96a06bcce295eda2afd0a94daaa96f5d180c1e4622a729 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-07T15:33:40Z. Version 1.66.3, release `29500ddf78a5`, commit `29500ddf78a56dfa40ec393c48db3f57702eb0ad` on `perf/hbots-fastopen`, working tree clean, result **PASS**.

Machine-readable copy: `releases\29500ddf78a5\gate-evidence.json` (sha256 `9625cf102910cb0e0e96a06bcce295eda2afd0a94daaa96f5d180c1e4622a729`) and the full gate logs in `releases\29500ddf78a5\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2304 tests passed, 0 failed, 3 skipped, in 171 files | 219.9   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 54.1    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2064 tests passed, 0 failed, 0 skipped, in 204 files | 37.7    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 33.3    |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 233 checks ok, 0 failed                              | 64.6    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-fastopen\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\29500ddf78a5" -Json` (in `.`)                                                                                                                  | 0    | pass: 5/5 journeys passed                                  | 41.8    |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok.

Tree: HEAD at start `29500ddf78a56dfa40ec393c48db3f57702eb0ad`, at end `29500ddf78a56dfa40ec393c48db3f57702eb0ad`; tracked files modified: none. Staged release: version 1.66.3, sha 29500ddf78a5, dirty False, externals copied; `dist/bin.mjs` sha256 `0fe8f7a9e03daa3d90d7589cc8f9f844dbfcbe36074fe4bcfae28f88fc5e53e4`.
<!-- gate-evidence:end -->
