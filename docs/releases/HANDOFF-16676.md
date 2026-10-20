# HANDOFF 1.66.76

Fixes taken from T3 Code nightly (upstream `pingdotgg/t3code`, tag
`v0.1.1-nightly.20261020.3386`) since our merge-base `2679d279ce` (26 Sep). Built by
Backend on live 1.66.72 (`1aeb673228da`). 29 upstream commits are cherry-picked with
`-x` (each one its own commit, the upstream sha is in its message), plus three small
commits that adapt tests to this fork and one test-only fake-CLI trigger. No migration
(the maximum stays 111); `PERSONAL_TASKS_CONCURRENCY` stays 5. Orchestrator v2 is not
touched. The full triage (what was taken, skipped and why) is
`dev-team/reviews/hbots-upstream-nightly-20261020.md`.

Branch `fix/hbots-upstream-fixes`. Suggested test tier: **QA, risky** (the picks touch
SQLite reads for background sweeps, the provider session paths, chat attachments and the
relay reconnect).

## 1. What changed, in plain words

Relay, reconnect and the phone

- A live session that drops (for example a socket iOS killed while the app was
  suspended) no longer leaves an old failure behind, so the app does not show a false
  failed connection (`145fba7ffc`).
- While the host swaps in a new Connect tunnel, the phone treats "not ready" as a
  temporary outage and retries, instead of a permanent permission block (`a143fa3c56`).
- After iOS or the browser closes the IndexedDB connection, the app reopens it instead
  of failing every later read and write; a failed commit (quota) now reports the error
  (`9c49228f54`).
- A stalled OAuth token request times out after 10 s instead of holding the credential
  lock (`f372c0061f`). A stalled cloudflared download is bounded to 10 minutes
  (`580948708b`).
- Settings save again after a stored value fails to decode (`4f909be2c1`).

Hangs and crashes

- A worker queue keeps running after one item fails or dies (`24e4b62c88`); a busy
  terminal can no longer starve its own history writes (`03b2105281`).
- A spawn that throws ENOTDIR becomes a normal error instead of a defect
  (`bafadf324c`). A local-path git remote no longer crashes the PR link projection
  (`38f3c62304`). File search returns a partial index instead of failing when the first
  scan times out (`fec71c5ab4`).
- The server-owned browser stays connected when one browser operation times out
  (`5c715c6941`).
- Background sweeps (PR discovery and similar) read only threads that can still settle,
  so they stop decoding thousands of settled threads from SQLite (`1d6f23b519`).

Providers

- Grok recovers from a crashed provider process (`050cfad04f`).
- Antigravity: files it cannot read natively are passed by saved path instead of
  rejecting the send (`def34c28b8`); a light status probe no longer erases the runtime
  version (`4c52938fdb`); repeat usage scans skip unchanged databases (`4d1f24ba41`).
- Claude: skills with scalar frontmatter load (`b3b6ae2ceb`); an explicit effort on a
  model the catalogue does not know is kept (`76f57f9b84`); a failed read of rate
  limits shows a retryable state, not "unsupported" (`2b6c291be9`); a failed
  background text job logs the CLI's own error (`7fd2ba7526`); provider logs skip
  thinking-token counter events (`ad2ac0f1ee`).
- Codex shadow homes replace stray SQLite maintenance locks (`140ee145ac`).

Chat display and lag

- Wide numbered-list markers (10., 100.) no longer clip (`8c61e254fd`); a bare `<A>`
  placeholder no longer opens a link over the following text (`5886bd8f19`); model ids
  such as `glm-5.3` in inline code stay code (`88fbc2cac7`); Windows paths in link and
  image destinations keep their backslashes (`6c8fed35dd`).
- Photo attachments are prepared from blobs, without a base64 loop on the main thread
  (`ff2fda7d6d`). Switching chats does not re-render for an unchanged preview list
  (`9ba614301c`).

(Hashes are the upstream commits; the fork commits carry them in `(cherry picked from
commit ...)`.)

## 2. Adapted picks

- `9c49228f54` (IndexedDB): its test conflicted; kept both tests, adapted one to this
  fork's thread-snapshot harness.
- `580948708b` (cloudflared download): upstream's relay test file differs a lot; the
  new timeout test is ported by hand to this fork's helpers.
- `9ba614301c` (preview state): this fork has no `listLoaded` flag, so that condition is
  left out (fork commit `fix(hbots): adapt upstream picks' tests ...`).
- `5c715c6941` (browser grace): the fork's extra "evicts an unanswered host" test needed
  its clock step moved by the 1 s grace.
- Test imports for `storage.test.ts` and `ClaudeModelCatalog.test.ts` use this fork's
  exports.

## 3. Not taken, on purpose

See the triage file. The main ones: upstream's SQLite reader and checkpoint workers
(we run our own single worker, Optimizer's area); the HTTP/2 crash fix (needs Node 26,
hbots runs Node 24); the Claude, Codex and OpenCode fixes that live only in
orchestration v2; the effect-acp rewrite; the React Compiler refactors.

## 4. Risks

- `1d6f23b519` changes which rows the background sweeps read (SQL `WHERE` on
  `settled_at`); the unfiltered call stays the default for every other reader.
- `ff2fda7d6d` rewrites the image preparation path (blob instead of base64 string).
- `def34c28b8` changes the attachment path hint for every provider, not only Antigravity.
- `9c49228f54` replaces the IndexedDB handle with a shared, reopenable one.
- Pre-existing, unchanged: 4 `ProviderService.test.ts` compaction tests fail on main
  too (three time out at 120 s); they are outside the fork gate.

## 5. Proof

Filled in after the staged build and the checks (390 px dark proof for the markdown
picks, the test per pick, throwaway-server run).

## Gate evidence

<!-- gate-evidence:begin sha=d0e0023b05b9fb0873b07c6853eebe3b59fd283e release=d0e0023b05b9 json-sha256=db3d94f849d0ab3785b5a83f2e7ca8802ab54f4fb8b6d56b3ad3a2ffb02784f0 result=FAIL -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-20T10:53:17Z. Version 1.66.76, release `d0e0023b05b9`, commit `d0e0023b05b9fb0873b07c6853eebe3b59fd283e` on `fix/hbots-upstream-fixes`, working tree clean, result **FAIL**.

Machine-readable copy: `releases\d0e0023b05b9\gate-evidence.json` (sha256 `db3d94f849d0ab3785b5a83f2e7ca8802ab54f4fb8b6d56b3ad3a2ffb02784f0`) and the full gate logs in `releases\d0e0023b05b9\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 1    | FAIL: 2939 tests passed, 2 failed, 4 skipped, in 213 files | 782.9   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 51.1    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2882 tests passed, 0 failed, 0 skipped, in 257 files | 38      |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 5.2     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 275 checks ok, 0 failed                              | 69.9    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-upstream-fixes\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\d0e0023b05b9" -Json` (in `.`)                                                                                                            | 0    | pass: 12/12 journeys passed                                | 289.5   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `d0e0023b05b9fb0873b07c6853eebe3b59fd283e`, at end `d0e0023b05b9fb0873b07c6853eebe3b59fd283e`; tracked files modified: none. Staged release: version 1.66.76, sha d0e0023b05b9, dirty False, externals copied; `dist/bin.mjs` sha256 `ec328ac5c2ccc81a2a63cf671819edb8bf2136b80af317911d232d9ad4985cb2`.
<!-- gate-evidence:end -->
