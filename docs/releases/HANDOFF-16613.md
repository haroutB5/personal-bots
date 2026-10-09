# HANDOFF 1.66.13

Memory freshness, evidence and factual-conflict handling. Built and staged only; QA and Security must clear it before DevOps activates it.

## Release and migration

- Staged release: `413a892b8a81`, built from the clean feature commit with `build.ps1 -CopyExternals`. Runtime externals copied, 16 packages. Live release pointer was not changed.
- Based on live 1.66.12 (`b21f7bd0bf`); includes the later nightly-update/revert history through `27c1267741`, which had no net file changes.
- Migration 104, `104_PersonalMemoryEvidence`, adds seven nullable columns to `personal_memory`: temporal_kind, observed_at, verified_at, evidence_json, origin_thread_id, origin_message_id and conflict. No entry is reclassified or rewritten by the migration.
- DevOps needs a pre-migration backup at migration 103. Binary rollback to 1.66.12 retains the additive columns; do not restore the live database automatically.
- Task concurrency remains 5. Rule wording/source guards and automatic save with Undo remain in place. The cancelled 16612 worktree was retained.

## Changes and behavioural proof

1. **Outdated notes:** automatic contextual and legacy retrieval exclude them even when they are the only match. Explicit search still returns them with an OUTDATED warning. Search, similar-note results, injected context and Context used carry provenance/freshness. Clearing feedback restores eligibility.
2. **Changing facts:** optional stable/historical/changing classification, observation date and evidence references. Changing facts age independently of their topic; stable facts keep their weight. Legacy rows remain unknown in storage, with conservative status detection at retrieval. Historical claims are labelled as past events.
3. **Evidence:** save accepts bounded evidence references and observed/verified dates. The server attaches the originating thread/message; preference origins use the actual quoted owner message. Context used shows provenance recorded with the turn. Replacement and Undo retain evidence; editing wording clears dates/evidence so proof is not silently inherited.
4. **Conflicts:** nightly tidy cannot choose between differing factual claims using saved recency or a semantic merge. It retains both claims and evidence and marks the conflict. Exact duplicate removal requires matching fact metadata. Preferences keep the latest instruction; the wording guard still checks merged rules. Correcting a marked conflict through save requires evidence and reported verification.
5. **Tests included; exposure screen deferred:** tests cover each behaviour above, including a fake tidy judge proposing the wrong recency winner. A cross-chat exposure-history screen is deliberately outside this release: reconstructing corrected versions and enforcing cross-thread visibility needs a separate API/UI and Security review. Existing usage records and 14-day turn traces remain available; Context used is the delivered per-turn view.

Tests are in `memoryEvidence.test.ts`, `memoryTidy.test.ts`, MCP `memoryHandlers.test.ts` and web `contextUsed.test.tsx`, alongside the existing replacement/Undo suites. They use isolated SQLite and fake judges, not real chats or accounts. The initial checkpoint gate found a duplicate schema property (TS1117); the duplicate was removed in the staged commit. The earlier checkpoint `11a70071b213` is rejected and must not be shipped.

## QA on a throwaway server

Run from this worktree:
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/personal/throwaway-server.ps1 -Name memory16613qa -Release 413a892b8a81`.
Use only that server's pairing link in an isolated dark-mode, phone-width browser. Verify the fake CLI's Session 10% indicator before sending messages.

- Send `MCPTOOL save_memory {"kind":"note","content":"The synthetic garden appointment is Tuesday.","temporalKind":"changing","observedAt":"2026-10-08T12:00:00.000Z","evidence":["https://example.com/appointments"]}`. Save should be automatic with Undo.
- Ask about the garden appointment, open Context used and check classification, source, observation date, evidence and originating message. Verification must say it is not recorded.
- Mark that note Outdated. Ask again: it must be excluded from automatic context. Send `MCPTOOL search_memory {"query":"garden appointment"}`: it must remain searchable with the explicit outdated flag/warning and provenance. Clear the feedback to restore retrieval.
- Save a replacement with its returned memory id in `replaces`; Undo must restore the original evidence. Verify rule saves still reject wording sourced only from web/task content.
- Use the isolated behavioural test's fake-judge fixture for conflicting facts and newest-rule precedence. Do not run a real nightly judge or alter live entries to manufacture a conflict.
- Stop via `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/personal/throwaway-server.ps1 -Stop memory16613qa`; confirm its root and port are gone.

## Security review points and limits

- Origin ids are assigned server-side; callers cannot nominate a fabricated origin through save_memory. Review owner-message selection and scope filtering on search/Context used.
- Evidence strings pass the existing secret guard, are bounded, and HTTP references with query strings/fragments are refused. No sources are fetched automatically and the UI renders plain text, not HTML.
- verifiedAt records the bot's claimed source check, not independent certification. Labels say so. A supplied date/reference is not proof that a source is correct; bots must recheck changing facts.
- Metadata is optional for compatibility. Old notes have unknown observation/evidence; no mass relabelling. Changing-state ageing reduces rank, it does not impose a universal expiry or guarantee truth.
- Conflict detection depends on the tidy judge proposing a relationship. It is conservative preservation, not an exhaustive contradiction detector. Existing explicit owner-approved/import transformations retain their established flow.
- No new cross-chat exposure endpoint or extra access grant was added. Check old-trace fallback and per-turn provenance under current visibility rules.
- QA and Security sign-off are separate from builder gates. DevOps owns activation and live verification.

## Gate evidence

<!-- gate-evidence:begin sha=413a892b8a8161a1ab7e9099ff4e37bf51dcd58b release=413a892b8a81 json-sha256=ddf6114a0b44ccc2302740fa0d4e1f226682fbded98ab29942fed69900bf80a5 result=PASS -->
Written by `scripts/personal/gate-evidence.ps1` at 2026-10-09T07:50:13Z. Version 1.66.13, release `413a892b8a81`, commit `413a892b8a8161a1ab7e9099ff4e37bf51dcd58b` on `feat/hbots-16613`, working tree clean, result **PASS**.

Machine-readable copy: `releases\413a892b8a81\gate-evidence.json` (sha256 `ddf6114a0b44ccc2302740fa0d4e1f226682fbded98ab29942fed69900bf80a5`) and the full gate logs in `releases\413a892b8a81\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate | Commands | Exit | Result | Seconds |
| --- | --- | --- | --- | --- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`) | 0 | pass: 2488 tests passed, 0 failed, 3 skipped, in 178 files | 256.1 |
| server-tsc | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`) | 0 | pass: exit code only | 44.5 |
| web-tests | `vp test run --project unit src/features/personal` (in `apps\web`) | 0 | pass: 2363 tests passed, 0 failed, 0 skipped, in 219 files | 31 |
| web-tsc | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`) | 0 | pass: exit code only | 9 |
| ps-tests | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0 | pass: 233 checks ok, 0 failed | 62.2 |
| e2e | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16613\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\413a892b8a81" -Json` (in `.`) | 0 | pass: 12/12 journeys passed | 275.3 |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `413a892b8a8161a1ab7e9099ff4e37bf51dcd58b`, at end `413a892b8a8161a1ab7e9099ff4e37bf51dcd58b`; tracked files modified: none. Staged release: version 1.66.13, sha 413a892b8a81, dirty False, externals copied; `dist/bin.mjs` sha256 `adf7e73dfb8905fd7596758313af4a0d44e0bd0d5cfe3ec52868df54f252375a`.
<!-- gate-evidence:end -->
