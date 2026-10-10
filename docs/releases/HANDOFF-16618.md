# HANDOFF 1.66.18

## What changed

Built and staged **1.66.18 / cd7d822352b4** from exact approved docs base `38e22537729990788c93e494109943e188318ea9`. Code commit `cd7d822352b41bda545f361e31fd0ed03a5650bf`, branch `fix/hbots-16618-audit`, isolated worktree `C:/Claude/AI/_wt/hbots-16618-audit`. Pushed to owner origin haroutB5. Builder implementation, real-boundary proof and default gates are complete. **Independent QA remains pending; this is not a QA approval or deployment authorization.** No activation, main merge, live authentication/settings/data write or provider job merge occurred.

Binary: `C:/Users/Ht/.personal-bots/releases/cd7d822352b4/dist/bin.mjs`, SHA256 `4f0bce3672a12553586b24b5a3d758c035f76e3686d96b3ae12ddca728aeadb1`. Build copied required public configuration internally (four public keys) and externals (16 packages, 77.8MB). Build log: `C:/Claude/AI/dev-team/qa/qa16618-build.log`. Code has no changes after the gated commit; only release documentation is committed afterward.

### Resulting behavior

- Personal transcripts mount at most 80 conversation items. Older and later controls move by 40 with overlap and restore a visible row's pixel position. All messages remain in the snapshot/store; history is not truncated or deleted. A reader's window follows message identity across new messages and prepends. The complete 1010-message fixture is reachable.
- Search and reply jumps first materialize the target's page, then center it instantly and retain the follow guard. Incoming messages and resize do not drag a reader back to the tail. Jump to latest rematerializes the tail and resumes following. Native text selection holds the current page through incoming messages.
- Preview evaluate normalizes its result before the real MCP CallToolResult constructor validates it: object undefined fields are omitted, array undefined/holes become null, top-level undefined becomes null, and supported JSON values remain intact. Cycles, non-finite numbers, bigint/functions/symbols and unsupported object classes fail with clear value-free errors. The registered toolkit handler, capability broker, annotations, input redaction and secret guard remain in the path.

### Seven-run comparison

Original baseline is retained at `C:/Claude/AI/dev-team/qa/qa16617-audit-baseline.json`. Candidate raw runs, summary, native proofs and replay scripts are separate in `C:/Claude/AI/dev-team/qa/qa16618-comparison/`; see its `README.md`. Same original 1402 synthetic messages / 40 chats / 12 initial bots, Chrome154 T3 preview, dark, unthrottled desktop UA, 390x844 and 1440x900, one discarded warmup then seven repeats. Timing began after default gates finished. Streaming-only fixture bots were removed through their synthetic API before navigation measurements.

| Metric (median ms unless stated) | 1.66.17 | 1.66.18 |
| --- | ---: | ---: |
| Phone long open | 594.4 | 80.1 |
| Phone long-open long tasks | 573 | 50 |
| Phone long back | 73.3 | 36.6 |
| Phone short open / back | 37.8 / 21.5 | 36.4 / 21.5 |
| Phone Team open / back | 37.0 / 21.0 | 20.3 / 20.6 |
| Phone list filter | 5.9 | 5.9 |
| Desktop long open | 587.1 | 81.9 |
| Desktop long-open long tasks | 493 | 0 |
| Desktop long back | 79.2 | 36.3 |
| Desktop short open / back | 55.7 / 37.6 | 55.7 / 38.2 |
| Desktop Team open / back | 34.1 / 22.4 | 29.5 / 21.0 |
| Desktop list filter | 6.5 | 6.3 |
| Long-chat DOM maximum phone / desktop | 12734 / 12817 | 1691 / 1774 |
| Search landing | 0/7 visible | 7/7 visible |
| Search debounce+RPC readiness | 334.8 | 334.7 |
| Search hit open | 569.4 | 94.6 |

Phone long-open range 63.9–258.1ms; desktop 76.9–88.7ms. Short-back outliers reach 120.3ms phone and 332.6ms desktop; desktop long-back reaches 239.6ms. Retained raw runs must be read alongside medians. No overflow or duplicate HTTP resource requests occurred. Phone Back records one resource per run whereas desktop records zero; the resource counter includes fetches and is not a duplicate-RPC claim. Short transcript adds seven DOM nodes, long transcript is bounded. No ceiling was changed, including J2 chatShell 237. These warm 1x metrics do not constitute the separate official 4x CPU performance-budget gate.

Five native fake paragraph streams remained running/streaming before and after five 5-second populated-list windows (25.9s): zero long tasks, zero frames over50ms, median frame p95 18.3ms (baseline18.4), ping p50 4.2ms (baseline6.4). Ping p95 had tails up to366.1ms; latency tails are retained, not hidden. Baseline established five waiting turns rather than continuous UI streaming, so this is stronger native stream proof, not an exact equivalence claim.

### Focused final-binary proof and scope

- `history-proof.json`: all1010 message IDs reached through24 earlier and24 later actions; at most80 mounted items; anchor movement0px except one0.25px rounding result.
- `stream-reader-proof.json`: native fake deltas become6→24 visible paragraphs while following,28→50 while reading with0px anchor movement,54→68 after returning to tail within0.5px. At most80 items throughout. Original fake lacked paragraph delimiters; only the copied fake CLI was repaired to emit completed paragraphs under the unchanged paragraph-streaming default.
- `reply-incoming-proof.json`: four native short and four old-long quote jumps; incoming native message delivery preserves selected text and old target position; Jump to latest exposes the new message. Continuous paragraph rendering is established by the separate fresh-session stream proof. Existing pre-patch fake sessions do not pick up a rewritten fake CLI.
- `menu-swipe-proof.json`: native Copy text handler captures visible text without overwriting the owner's clipboard, native selection includes it, owner-row horizontal swipe reveals timestamp and resets. Existing swipe/reply/select/archive suites also pass.
- `team-back-proof.json`: Team-opened conversation's Back label and destination remain Team. Normal Bots Back is included in the seven-run replay and end-to-end journeys.
- Native MCP tests call the capability broker and registered evaluate handler, then encode the actual CallToolResult schema: nested undefined, null/top-level controls, array holes and unsupported values are covered. JSON normalizer cases also cover cycles and shared objects. Existing guard/capability tests pass.
- ConversationScreen supplies normal, task/routine and archive transcripts; GroupConversationScreen uses the same MessageList. Both receive the window/jump behavior. Read-only archive action guards, avatars, timestamp gestures and task concurrency5 remain unchanged and covered by existing tests. Full personal web tests include these shared callers; fresh staged-browser long-history proof is for normal chats, not independent end-to-end task/group/archive sign-off.
- Excluded: upstream non-personal MessagesTimeline, queued-message list behavior, provider contracts/UI, history storage/paging APIs, migrations, credential logic, budgets and release tooling. No large dependency was added. A single very large markdown message can still have many descendants; this bounds conversation items rather than every descendant or all snapshot memory.

### Review and release sequence

Independent QA should replay the exact staged binary, inspect older/later controls on a real iPhone when available, verify mixed task/group/archive rows and variable-height history anchors, repeat short/long search and reply while messages arrive, and inspect the retained timing outliers. No physical iPhone or real paid provider behavior is claimed. QA must report separately; no builder proof substitutes for it. CTO can finalize approval docs only after that review; DevOps owns any later idle-only activation and live confirmation.

All comparison data is synthetic. No paid call, redemption, real bot chat or owner data was used. All owned test processes/browser are stopped before builder handoff. The stopped prototype fixture was retained because automatic approval review rejected its deletion; final fixtures are retained stopped for QA replay. Final validators bind the docs commit to this exact clean code release and evidence hash.

## Gate evidence

<!-- gate-evidence:begin sha=3611c8bc5580a171e49edc686a9891b50389d34a release=3611c8bc5580 json-sha256=64f2613b80fca9cc2713989ea707a8c3bf119894c16f2b227717171d611c4919 result=PASS -->
Written by `scripts/personal/gate-evidence.ps1` at 2026-10-10T14:08:03Z. Version 1.66.18, release `3611c8bc5580`, commit `3611c8bc5580a171e49edc686a9891b50389d34a` on `fix/hbots-16618-audit`, working tree clean, result **PASS**.

Machine-readable copy: `releases\3611c8bc5580\gate-evidence.json` (sha256 `64f2613b80fca9cc2713989ea707a8c3bf119894c16f2b227717171d611c4919`) and the full gate logs in `releases\3611c8bc5580\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate | Commands | Exit | Result | Seconds |
| --- | --- | --- | --- | --- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`) | 0 | pass: 2509 tests passed, 0 failed, 3 skipped, in 179 files | 292.8 |
| server-tsc | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`) | 0 | pass: exit code only | 47.8 |
| web-tests | `vp test run --project unit src/features/personal` (in `apps\web`) | 0 | pass: 2403 tests passed, 0 failed, 0 skipped, in 222 files | 28.9 |
| web-tsc | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`) | 0 | pass: exit code only | 9.9 |
| ps-tests | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0 | pass: 233 checks ok, 0 failed | 101.7 |
| e2e | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16618-audit\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\3611c8bc5580" -Json` (in `.`) | 0 | pass: 12/12 journeys passed | 279.9 |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `3611c8bc5580a171e49edc686a9891b50389d34a`, at end `3611c8bc5580a171e49edc686a9891b50389d34a`; tracked files modified: none. Staged release: version 1.66.18, sha 3611c8bc5580, dirty False, externals copied; `dist/bin.mjs` sha256 `4f0bce3672a12553586b24b5a3d758c035f76e3686d96b3ae12ddca728aeadb1`.
<!-- gate-evidence:end -->
