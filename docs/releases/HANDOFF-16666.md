# HANDOFF 1.66.66

Pin move, the DeepSeek card's refresh fix, and the Security fix that blocked the first 1.66.66
staging, on top of 1.66.65 (the bot settings Routines section and the "Today" next-run label). The
DeepSeek Harness (`@deepseek-ai/dsh`) moves from 0.2.0-rc.2 to **0.2.1-rc.2** (the release DeepSeek
recommends for V4.1-Flash-1017), and the card now shows a newly published harness as soon as npm has
it while leaving the update action to a release. Security's re-review of the first security fix found
one medium over-deny: the harness home's parent is the data root, so the shell-workdir rule denied
every workdir in `personal-workspace`. `c29f265b50` narrows it (read roots keep their parent; write
roots are guarded themselves) and adds a production-layout test. No migration (the maximum stays
111); `PERSONAL_TASKS_CONCURRENCY` stays 5. Staged only; nothing is activated.

**Security first: live 1.66.63 is already bypassable, and this release closes it.** A bot's
provider cwd is `<data root>\personal-workspace`, so `..\userdata\secrets\<name>` resolved into the
sealed secret store and the deny plugin's raw-string check did not see it. On a throwaway root with
the live 0.2.0-rc.2 runtime and the old plugin, a relative read returned a canary file from the store
and a relative write created a file inside it (section 5). 0.2.1 adds a `working_directory` tool that
makes the same class easier (set cwd to `...\userdata`, then `secrets\...`), which is why the pin
move must not ship without this fix. The new plugin is now installed beside the live 0.2.0-rc.2
runtime too, so new DeepSeek chats on 1.66.63 load the fix without a restart; chats whose dsh
process is already running keep the old module until this release restarts them.

Branch `release/hbots-16664`, built from the merge of `release/hbots-16665`'s head `82e9f9ffbc`;
code commits `ed54d852a9f0` (pin), `87a32d51e745` (card), merge `d771b8c2f1`, version/notes
`1fde3530074a`, the security fix `0b438620b7d8`, the QA follow-ups `b08206786074` (cache
bypass scoped to the manual Refresh, banner skips no-action providers), and the over-deny fix
`c29f265b50`; staged release `c29f265b50a9`. Live is still 1.66.63 (`current.txt`
`9d0d33b46120`).

## 1. Why the pin moves

DeepSeek published `@deepseek-ai/dsh` 0.2.1-rc.2 on 17 Oct 08:36Z and its notes say it adds
support for DeepSeek-V4.1-Flash-1017. The same API update tells clients to use Harness 0.2.1-rc.1
or later for the new model. The public `latest` dist-tag is still 0.2.0-rc.2; `next` is now
0.2.1-rc.2.

The npm publish was still rolling out when this work started: at 08:50Z
`dsh-client-ui-settings-account@0.2.1-rc.2` did not exist, so a fresh lockfile failed with ETARGET;
at 08:55Z its tarball still answered 404 and `npm ci` failed. The package appeared by 09:04Z and a
registry walk then found all 273 exact rc.2 packages present (`qa\dsh-021-rc2\rc2-graph-check.json`).
The runtime installed cleanly on the retry and reports `0.2.1-rc.2`.

## 2. What the 0.2.1 line changes for us

Read from the real release notes (`dsh-v0.2.1-alpha.4/5`, `rc.1`, `rc.2`).

| Change                                                                                                                              | Touches hbots?                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rc.2: support for DeepSeek-V4.1-Flash-1017                                                                                          | This is the reason for the move. No hbots code change.                                                                                                                                                |
| rc.2: DeepSeek Search and Fetch APIs, enabled in Web Search settings                                                                | Handled. The new base row `web-deepseek-api` is now explicitly disabled in our patch (Security follow-up); `web-search-deepseek` stays disabled and `tool-web` keeps `search: false`.                 |
| rc.1: new `working_directory` tool and SDK APIs                                                                                     | Handled. `tool-working-directory` is disabled in **every** mode, not only Minimal (Security blocker, section 5). The `working-directory` service row stays because dsh's fs tools resolve through it. |
| rc.1: Minimal mode can read images and auto-compact; `/compact` in Web/Desktop                                                      | Feature gain, Minimal mode only. No regression in the 10-turn run.                                                                                                                                    |
| rc.1: optional plugins in Minimal mode; Claude Code/Codex bundles allowed in ACP profiles                                           | No. We still insert one plugin (the deny plugin) by file URL; the A/B proves it still denies.                                                                                                         |
| rc.1: runtime utilities, MCP protocol integrations and image processing updated                                                     | Watched. The t3-code MCP server still mounts over ACP; images still pass.                                                                                                                             |
| rc.1: headless API-key precedence env/.env first, saved credentials not read                                                        | Good for us: we pass `DEEPSEEK_API_KEY` in the child env; the stand-in saw the request and the key check passed.                                                                                      |
| rc.1: removed the `both` tool-presentation mode; removed runtime invariant plugins; removed per-row `dshHome` in agent-instructions | No. We use `ptc`/default, load no invariant plugin and set no `dshHome`.                                                                                                                              |
| rc.1: Agent Team direct Inbox, subagent notifications returning child ids, automation tool scoping                                  | Not part of our ACP profile/turn path. The A/B does not exercise dsh's own subagents.                                                                                                                 |
| rc.1: pi-ai 1.0.2, Azure provider rename                                                                                            | No.                                                                                                                                                                                                   |
| rc.1/rc.2: key/token masking in sent messages                                                                                       | Display only; the alpha.3 report proved it on the wire. The A/B reproduces the same result: the model and the tool see the raw key, and `{{secret:...}}` is untouched.                                |

## 3. The pin move

- `scripts\personal\dsh-runtime\package.json`: `"@deepseek-ai/dsh": "0.2.1-rc.2"` (exact, no caret),
  and `package-lock.json` regenerated for rc.2 (1,888 rc.2 references, no 0.2.0-rc.2 left).
- `scripts\personal\install-dsh.ps1`: `-Version` default and help line.
- `apps\server\src\provider\Drivers\DeepSeekEngine.ts`: `DSH_PINNED_VERSION = "0.2.1-rc.2"`, so
  `DSH_RUNTIME_DIR_NAME` follows and the card does not say Unavailable.
- `apps\server\src\provider\acp\DshAcpSupport.ts`: `tool-working-directory` is disabled by one
  global row in every mode (removed from `MINIMAL_DISABLED_ROWS`); `web-deepseek-api` is disabled;
  runtime-path doc comment.
- `packages\contracts\src\settings.ts`: the Harness-path placeholder.
- `scripts\personal\qa\dsh-live-smoke.mjs`: the runtime path it probes.
- `apps\server\src\provider\acp\DshAcpSupport.test.ts`: the pinned-version/path and row
  expectations.

The rc.2 runtime is installed side by side at
`%USERPROFILE%\.personal-bots\runtimes\dsh-0.2.1-rc.2`; `dsh-0.2.0-rc.2` is still installed for
rollback. Runtime profile diff (`qa\dsh-021-rc2\runtime-config-diff-rc2.json`): the base profile
goes from 94 to 96 rows, adding `remote-access`, `working-directory`, `tool-working-directory` and
`web-deepseek-api`, and dropping `skill-badge` and `tool-ralph`. All 15 row ids our launch patch
names still exist; the ACP app's own profile is row-for-row identical and `session/resume` is still
implemented.

## 4. The card refresh sees a newly published harness

Harout's addition to this release. Before it, the dsh engine had no npm package to compare with,
so the card never checked for a newer harness; and the registry answer was cached for an hour, so
a manual Refresh on any provider card could return the stale version.

- **dsh compares with `@deepseek-ai/dsh`.** The card takes the newest semver of npm `latest` and
  `next` (a harness release candidate lands on `next` first) and never `alpha`. It shows the
  existing `behind_latest` advisory with the version, and `canUpdate` is false: moving the pin
  needs a release, so there is no Update button. The same registry source is used for the Claude
  engine's own package as before.
- **A manual Refresh bypasses the 1 h cache for that call**, then stores the fresh answer; the
  background interval and the boot check keep using the cache. The flag is threaded from
  `makeManagedServerProvider`'s `refresh()` through every driver's `enrichSnapshot` into
  `resolveLatestProviderVersion`.
- **The card labels the build.** A DeepSeek dsh card reads `Harness v0.2.1-rc.2`, so the version
  cannot be mistaken for the model version.

**Unit proof** (all in the fork gate): `DeepSeekDriver.test.ts` - dsh behind `next` shows
`behind_latest` with 0.2.1-rc.2, only `latest` and `next` are requested, `alpha` is never
requested, `canUpdate` is false; `providerMaintenance.test.ts` - a forced lookup bypasses the
cached version and stores the new one; `makeManagedServerProvider.test.ts` - a manual refresh
passes the bypass flag, the background check does not; the Claude engine's advisory is unchanged;
`ProviderInstanceCard`/`providerStatus` tests for the label and the detail.

**Throwaway proof** on both final builds: with Harness path pointed at the old `dsh-0.2.0-rc.2`
runtime, the card reads `DeepSeek Harness v0.2.0-rc.2 Unavailable` **and** shows
`Update available: v0.2.1-rc.2 is available.` (no update action). With the new runtime it reads
`DeepSeek Harness v0.2.1-rc.2 Authenticated` and shows no advisory. Runs
`qa\dsh-021-rc2\runs\old-2026-10-17T10-35-17\` and `...\new-2026-10-17T10-36-54\`, repeated on the
security build by `old-2026-10-17T11-23-05` / `new-2026-10-17T11-26-06` and on the `b08206786074`
release by `old-2026-10-17T11-48-58` / `new-2026-10-17T11-51-06`. The same card result held on the
final `c29f265b50a9` re-check (`old-2026-10-17T12-33-03` / `new-2026-10-17T12-34-08`).

## 5. Security fix: relative paths and the cwd tool

Security blocked the first 1.66.66 staging (task 49be2588). dsh 0.2.1 adds `working-directory` and
`tool-working-directory` (dsh-base `cordis.patch.yml:166-170`). We disabled the tool only in
Minimal, so Standard (the default) and Code offered it. It sets the session cwd, dsh-tool-fs
resolves relative paths against that cwd (`dsh-tool-fs/lib/index.js:171-192`), and the deny plugin
compared only the raw `file_path`/`path` strings (`norm`/`under`/`tailMatches`).

**The live question, answered first.** Yes: live 1.66.63 (0.2.0-rc.2, no cwd tool) was already
bypassable with a relative path from the bot's default session cwd. The provider cwd is
`<data root>\personal-workspace`, so `..\userdata\secrets\qa-relative-canary-<R>.txt` read a canary
file from the sealed store, and a relative write created a file inside it. The baseline used the old
plugin and skipped the database write so it could not corrupt the throwaway. Evidence:
`qa\dsh-021-rc2\runs\old-2026-10-17T11-10-51\` (T3b FAIL by design: all three relative reads
ALLOWED with the canary content, relative write created the file).

The fix, all in `0b438620b7d8`:

1. **`tool-working-directory` is disabled in every mode** by one unconditional launch row. It was
   removed from `MINIMAL_DISABLED_ROWS` so there is one owner. The `working-directory` **service**
   row is deliberately kept: dsh-tool-fs 0.2.1 calls `ctx.workingDirectory.ensure` for every
   relative fs path (`dsh-tool-fs/lib/index.js:172`) and dsh-tool-fs-search does the same
   (`lib/index.js:168`), so disabling the service would break every read and write. The A/B shows
   no `working_directory` in Standard (101 tools), Code (1 tool) or Minimal (79 tools), and the
   launch patch carries the disabled row in all three.
2. **The deny plugin resolves and canonicalizes every candidate path** before `under`/`tailMatches`.
   It takes the cwd from `ctx.workingDirectory.get(session)` on 0.2.1, then falls back to
   `session.header.cwd` (0.2.0). It normalizes `\`/`/`, `.` and `..`, strips the `\\?\`/`\\.\`
   prefixes, resolves through `realpathSync.native` (8.3 short names, junctions, symlinks, trailing
   dots) and canonicalizes a not-yet-existing write from its nearest existing ancestor. A relative
   path with no visible cwd is denied when it names a protected folder or file. It covers
   `read`/`read_image`/`edit`/`write`/`glob`/`grep`, the shell `workdir`/`cwd` arguments, and a
   `working_directory` call as defence in depth. The shell-workdir rule protects the parent of each
   read root (so a shell in `<data root>\userdata` cannot read `secrets\x` without naming it) and
   each write root itself (the SQLite files and the harness home), not the parent of the harness
   home: in production `<data root>\dsh` sits beside `<data root>\personal-workspace`. The shell
   command text also collapses `.` and duplicate separators before its tail match. This remains a
   tool-level deny, not an OS boundary, exactly as before.
3. **`web-deepseek-api` is explicitly disabled** in the privacy patch, so the DeepSeek Search/Fetch
   API routes never register with the bot's credential, even though `tool-web` only fetches over
   http. The A/B PATCH check now holds 6/6 privacy rows and 12 launch rows.
4. **The plugin is installed beside both runtimes** (the same copy `install-dsh.ps1` performs):
   `dsh-0.2.0-rc.2` and `dsh-0.2.1-rc.2` both hold sha256
   `7270EC70F697F8C64115C9F11153D72B48FB00F37477E001B6DF8F841A9402F3`, identical to
   `scripts\personal\dsh-runtime\hbots-deny-plugin.mjs` in the release. Because the live pin is
   0.2.0-rc.2, the live runtime now loads the fixed plugin for new DeepSeek chats; no server restart
   was performed. Chats with an already-running dsh process keep the old module until this release
   restarts them. **Do not run `install-dsh.ps1` from a checkout older than 1.66.66 after this
   release:** the script copies the plugin from the calling checkout (`install-dsh.ps1` lines 64-72),
   so a run from `main` while `main` is still pre-1.66.66 would put the old plugin back beside the
   live runtime and reopen the bypass. After this release merges, `main` carries the fixed file.

**Unit proof.** `DshDenyPlugin.test.ts` (9 tests) drives the shipped `.mjs` through its own hook:
relative from the workspace and from a data-root cwd, `./`, `..`, mixed and double separators, case,
`\\?\`, 8.3 short names, no-cwd relative names, shell workdir, and the `working_directory` call
(`path` and dsh's `cd`), plus allowed paths (DB reads, ordinary workspace files, a folder named
`secrets` deeper in the workspace). A production-layout test (new in `c29f265b50`) uses the real
`<baseDir>\dsh` / `<baseDir>\personal-workspace` / `<baseDir>\userdata` shape and asserts `.`, `src`
and the workspace are allowed while `..\userdata`, `..\userdata\secrets`, `<baseDir>\dsh` and
`..\dsh\usage` are denied. `DshAcpSupport.test.ts` (26 tests) asserts both rows in Standard, Code and
Minimal. These are targeted tests: the default fork gate runs `vp test run src/personal src/mcp`,
which does not collect `src/provider/acp`, so the gate's own server count stays 2,920.

**A/B T3b** (same rig, same throwaway cwd, both runtimes):

| Attempt                                        | rc.2 old (0.2.0)          | rc.2 new (0.2.1)          |
| ---------------------------------------------- | ------------------------- | ------------------------- |
| read `..\userdata\secrets\<canary>`            | DENIED                    | DENIED                    |
| read `..\userdata\secrets\..\secrets\<canary>` | DENIED                    | DENIED                    |
| read `..\userdata\\secrets\\<canary>`          | DENIED                    | DENIED                    |
| write `..\userdata\secrets\<new file>`         | DENIED (file not created) | DENIED (file not created) |
| write `..\userdata\state.sqlite`               | DENIED                    | DENIED                    |
| `working_directory` offered (standard/code)    | no (tool absent)          | no (disabled)             |
| launch patch disables `tool-working-directory` | true/true                 | true/true                 |

All denials carry `blocked: path is bot state protected by the hbots server`.

**The over-deny and its fix (`c29f265b50`).** The first security fix built `protectedParents` from
both the read and write roots, so the harness home `<baseDir>\dsh` contributed its parent
`<baseDir>`; every shell workdir in `<baseDir>\personal-workspace` was then denied. Production puts
`dsh` beside `personal-workspace`, so this hit the normal workspace, not a test-only layout (the
unit tests had put dsh under `userdata`). `c29f265b50` keeps the parent rule for the read roots and
guards the write roots themselves. The `working_directory` branch also reads dsh's real `cd`
argument instead of only `path`. The production-layout test fails on the old plugin; 35/35 pass now
in `DshDenyPlugin` + `DshAcpSupport`.

**A/B T3c, re-stage `c29f265b50a9`** (only SETUP, T3b and T3c were re-run; `dist/bin.mjs` is
byte-identical to `b08206786074`, so the 15-row table above still stands):

| workdir                                  | rc.2 old (0.2.0) | rc.2 new (0.2.1) |
| ---------------------------------------- | ---------------- | ---------------- |
| `.`                                      | ALLOWED (ran)    | ALLOWED (ran)    |
| `src`                                    | ALLOWED (ran)    | ALLOWED (ran)    |
| absolute `<root>\personal-workspace`     | ALLOWED (ran)    | ALLOWED (ran)    |
| `..\userdata`                            | DENIED           | DENIED           |
| `..\userdata\secrets`                    | DENIED           | DENIED           |
| absolute `<root>\dsh` (the harness home) | DENIED           | DENIED           |
| `..\dsh` (relative)                      | DENIED           | DENIED           |

All denials carry the same plugin reason; every allowed case ran its `Write-Output` marker. T3b also
passed again on both runtimes (all relative reads/writes denied, canary not read, no file created).
Runs: `runs\old-2026-10-17T12-33-03\` and `runs\new-2026-10-17T12-34-08\`; the new card reads
`DeepSeek Harness v0.2.1-rc.2 Authenticated` with no advisory. QA's cache-scope and banner follow-ups
are in the same release (section 6); the final staged artifact is `c29f265b50a9` (section 7).

## 6. QA follow-ups in the same re-stage

QA's 1.66.66 report (task 832d15d4, `qa\hbots-16666\REPORT.md`) passed everything else and raised
two low items. Both are in `b08206786074`.

**A. The cache bypass was too wide.** `makeManagedServerProvider.refresh` forced the fresh npm
lookup for every caller, so the 2-minute usage-limit fallback re-check (about 30 lookups an hour
per fallen-back bot), Claude's usage re-check, Codex after a redeem and the
maintenance/installation flows all skipped the 1 h cache. Fix: `refresh` is the cached path every
background and internal caller uses; a new optional `refreshLatest` is the only uncached path. The
registry forwards it only when the RPC asks: `server.refreshProviders` has a new
`refreshLatestVersion` field, and only the settings card's manual Refresh button sends it
(`{ refreshModels: true, refreshLatestVersion: true }`). The fallback, usage, redeem, maintenance,
workspace and onboarding callers do not. Unit proof: `makeManagedServerProvider.test.ts` drives
boot, `refresh` (cached) and `refreshLatest` (forced); `ProviderRegistry.test.ts` shows
`refreshInstance(id)` uses `refresh` and `refreshInstance(id, { refreshLatestVersion: true })`
uses `refreshLatest`; `ProviderSettingsPanel.environment.test.tsx` asserts the manual button
sends the flag; `providerMaintenance.test.ts` keeps the TTL/forced-cache behavior.

**B. The launch banner named DeepSeek as updatable.** `isProviderUpdateCandidate` accepted any
enabled `behind_latest` provider, including the dsh harness whose card has `canUpdate: false` and
no update action. Fix: the candidate now requires `versionAdvisory.canUpdate === true`, so the dsh
harness is left out of "can be updated from provider settings" and the banner names only
providers the user can update there. Unit proof: a no-action dsh provider is not a candidate, and
a mixed Claude + dsh list collects only Claude.

## 7. A/B on the staged release

Throwaway roots under `%TEMP%` on the `b08206786074` build (read-only), the DeepSeek instance's
**Harness path** pointed at each runtime, a stub DeepSeek API with a fake key, dark mode, 390x844.
Old = 0.2.0-rc.2, new = 0.2.1-rc.2. Same rig, fixtures and check order for both runs. The final
re-stage `c29f265b50a9` has the same server binary and re-ran SETUP, T3b and T3c (section 5); it is
the artifact staged for DevOps.

| #     | Check                                                      | rc.2 old | rc.2 new | Evidence (identical unless stated)                                                                                                                                                                                    |
| ----- | ---------------------------------------------------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SETUP | DeepSeek on dsh with that runtime, 3 bots, 3 chats         | PASS     | PASS     | old card `DeepSeek Harness v0.2.0-rc.2 Unavailable` plus the advisory `Update available: v0.2.1-rc.2 is available.`; new card `DeepSeek Harness v0.2.1-rc.2 Authenticated`; 3 modes stored as deepseek/deepseek-flash |
| PATCH | launch patch rows, privacy rows, mode, spawned runtime     | PASS     | PASS     | 12 rows; 6/6 privacy rows hold (including `web-deepseek-api`); `tool-working-directory` disabled in every mode; `hbots-deny` inserted; the dsh process runs the runtime under test                                    |
| T1    | plain text turn (standard)                                 | PASS     | PASS     | reply carried the MK1 marker; 1 API request                                                                                                                                                                           |
| T2    | tool call round trip (`pwsh`)                              | PASS     | PASS     | tool result `HELLOQA...` returned to the model                                                                                                                                                                        |
| T3    | deny plugin denies a bot-state absolute path               | PASS     | PASS     | `Error: blocked: path is bot state protected by the hbots server`                                                                                                                                                     |
| T3b   | relative paths from the session cwd; no cwd tool           | PASS     | PASS     | all relative reads/writes denied, canary not read, no file created; no `working_directory` offered (standard 101 tools, code 1, minimal 79)                                                                           |
| T4    | steer into a running turn                                  | PASS     | PASS     | 2 turns completed, steer marker in the reply, 0 errors                                                                                                                                                                |
| T5    | image under the cap                                        | PASS     | PASS     | stored 1064 B, sent `image/png 390x300 1064 B` byte-identical                                                                                                                                                         |
| T6    | image over the cap (8,449,624 B source)                    | PASS     | PASS     | composer brought it to 219,854 B; sent `image/jpeg 872x1890 202,501 B` (cap 2,097,152)                                                                                                                                |
| T7    | code + minimal each run a turn                             | PASS     | PASS     | both completed; Minimal offers **79 tools**, no `working_directory`; Code offers 1 tool, no `working_directory`                                                                                                       |
| T8    | long chat (10 turns) + compaction signal                   | PASS     | PASS     | 10/10 completed, max 57 messages in one request, 32 requests, no compact request (the stub cannot force the real window)                                                                                              |
| T9    | session resumes after a server restart                     | PASS     | PASS     | same dsh session id before and after; 0 not-resumable lines; 0 errors                                                                                                                                                 |
| T10   | key in a message + key and `{{secret:...}}` in a tool call | PASS     | PASS     | raw key reached the model and the tool; placeholder reached the tool intact; key stored raw in `state.sqlite`                                                                                                         |
| T11   | usage ledger parsed                                        | PASS     | PASS     | 3 files, 36 lines, **$0.571071** on both, no unexpected fields                                                                                                                                                        |
| T12   | 0 ERROR lines, 0 page errors, privacy rows on disk         | PASS     | PASS     | 0 ERROR/FATAL, 0 page errors, 0 session-log uploads, no credentials file, `web_search` not offered                                                                                                                    |

Raw runs and the full report: `%USERPROFILE%\.personal-bots\qa\dsh-021-rc2\REPORT.md`,
`runs\old-2026-10-17T11-48-58\` and `runs\new-2026-10-17T11-51-06\`. The security-only
`0b438620b7d8` pair is `runs\old-2026-10-17T11-23-05\` / `runs\new-2026-10-17T11-26-06\`; the
first QA-fix old run (`old-2026-10-17T11-45-59`) failed T12 only on the known throwaway Clerk CDN
page error, and the clean re-run above is the evidence. The baseline that proved the live bypass
is `runs\old-2026-10-17T11-10-51\`. The earlier `1fde3530074a` A/B (14 rows) is superseded and
kept for the record. The over-deny re-check on `c29f265b50a9` is
`runs\old-2026-10-17T12-33-03\` / `runs\new-2026-10-17T12-34-08\`.

## 8. npm audit

`npm audit --omit=dev` on the new lockfile: **8 moderate, 0 high, 0 critical**. All eight trace to
`fflate` (infinite loop parsing a malformed ZIP64 archive) through `@deepseek-ai/libreoffice-kit`
-> `dsh-skill-office` -> `dsh-sdk-app`/`dsh-sdk-minimal` -> `dsh`. No fix without a semver-major
bump of the dsh packages. hbots never invokes dsh's Office/PDF skill, and the advisory needs a
malformed archive to parse. Output: `qa\dsh-021-rc2\npm-audit-rc2.json`.

## 9. Builder verification

- Targeted tests: 35 passed in `DshDenyPlugin.test.ts` (9) + `DshAcpSupport.test.ts` (26); the
  production-layout test fails on the old plugin, so it catches Security's over-deny; 92 passed
  (13 skipped) in `makeManagedServerProvider.test.ts`, `ProviderRegistry.test.ts` and
  `providerMaintenance.test.ts` for the cache-scope fix; 56 passed in the web banner and settings
  panel tests. The whole provider tree was also run: 1,791 passed, 2 failed. The two failures are
  pre-existing `ClaudeAdapter.test.ts` assertions about `skillOverrides` (the 1.66.62 skill trim is
  on by default and the test expects the untrimmed settings). No file in this release touches the
  Claude adapter, and the fork gate does not run that suite. Flagged for a separate fix.
- Fork gate: server 2,920 passed (4 skipped), web 2,877 passed, PS 262 checks, e2e 12/12, all PASS
  (see Gate evidence below). `apps\server` and `apps\web` `tsc --noEmit` exit 0.
- Build: `build.ps1 -CopyExternals` staged `c29f265b50a9` with `dirty=False` and
  `externals=copied`; `bin.mjs --version` answers `t3 v0.0.42`, and the bundle contains the new
  rows. Because `c29f265b50` touches only the plugin and its test, `dist/bin.mjs` is byte-identical
  to the `b08206786074` build (sha256 `782b9eeb...`); the release commit is what carries the fixed
  plugin for a later `install-dsh.ps1`. The build printed the usual PowerShell stderr noise from
  vite's reporter after its staging lines (the same known nonzero process exit as the earlier build);
  the artifact is complete and the gate ran on it.
- Runtime: `node ...\dsh-0.2.1-rc.2\node_modules\@deepseek-ai\dsh\lib\bin.js --version` answers
  `0.2.1-rc.2`; `dsh-0.2.0-rc.2` is still installed. Both runtime plugin copies equal the checkout
  file (sha256 `7270EC70F697F8C64115C9F11153D72B48FB00F37477E001B6DF8F841A9402F3`).
- The card's harness label, the old-runtime advisory, the manual-Refresh scope and the banner
  wording were proved in the throwaways and unit tests; see sections 4 and 6.
- Test-time load: the dependency install and the test runs were heavy disk jobs and the live stall
  recorder logged pauses up to 5.9 s between 09:11 and 09:19Z, all `process-paused` with the live
  1.66.63 process idle (disk starvation), not from this release. Nothing was activated; the release
  waiter still has its idle gate.

## 10. What QA should focus on

1. **Security (new):** on a DeepSeek bot in Standard mode, ask it to read
   `..\userdata\secrets\data-encryption-key.json` (and the same with `.\`, `..\` and mixed
   separators). It must be denied on live 1.66.66. Ask it to write `..\userdata\state.sqlite`; it
   must be denied. Repeat once in Code mode. Also ask for a shell command with `workdir` `.`, `src`
   and the absolute workspace path: each must run (this is the over-deny regression check). With
   `..\userdata`, `..\userdata\secrets` or `<data root>\dsh` as the workdir it must be denied.
2. Standard and Code must offer no `working_directory` tool; Minimal keeps 79 tools and no
   `working_directory`.
3. A real DeepSeek turn on `deepseek-flash` (V4.1-Flash-1017) on a DeepSeek bot, standard mode.
4. The DeepSeek settings card: `DeepSeek Harness v0.2.1-rc.2 Authenticated`, no Unavailable, no
   update advisory (the pin is current). Press Refresh; it must stay current, and no
   `working_directory` or cache storm should follow. No Update button on a harness advisory, and
   the launch banner must not say DeepSeek can be updated from provider settings.
5. Minimal mode: a turn works, the persistent PowerShell works, and no `working_directory` tool is
   offered.
6. An image under and over 2 MiB, and a 10-turn chat.
7. Session resume after a server restart (same dsh session id).
8. Startup log since the restart: 0 ERROR, 0 `Token:`/`Pairing URL` lines.

## 11. Rollback

- **Do not roll back to 1.66.65 or 1.66.63 without the plugin.** Those binaries predate the security
  fix and the bypass returns. Because the plugin is loaded from the runtime folder, the fixed plugin
  is already beside `dsh-0.2.0-rc.2`, so new chats stay protected even on the older binary; a revert
  of the plugin copy would reopen it.
- Fastest safe rollback: a binary rollback to another 1.66.66 build that carries `c29f265b50`
  (security fix, QA follow-ups and the over-deny fix), or to 1.66.65/1.66.63 with the fixed plugin
  still in place, with `restart.ps1 -Release <sha> -NoPrune`. The rc.2 runtime stays installed.
  `c29f265b50a9` and `b08206786074` share the same server binary, so either is safe with the fixed
  plugin beside the runtime.
- Source rollback: revert `c29f265b50`, `b08206786074` and `0b438620b7d8` and the pin/card commits
  on top of the merged 1.66.65 tree (or set `DSH_PINNED_VERSION` and the `install-dsh.ps1` default
  back to `0.2.0-rc.2` and regenerate the lockfile), rebuild, and re-stage. Keep the plugin copy and
  the two launch rows.
- **Never re-run `install-dsh.ps1` from `main` until 1.66.66 is merged.** The script copies
  `hbots-deny-plugin.mjs` from the calling checkout, and `main` still holds the old plugin. Such a
  run would overwrite the fixed plugin beside both runtimes and reopen the relative-path bypass on
  the live server without any restart. After the release lands and `main` is fast-forwarded, a run
  is safe and idempotent.
- No migration, so no data restore is involved.

## Gate evidence

<!-- gate-evidence:begin sha=c29f265b50a960aab268892f9614af98a0120d44 release=c29f265b50a9 json-sha256=b9408a82fab4cde89735101d0168db37d7d07dedd6e4fd434c93ab25f143b6d2 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-17T12:32:59Z. Version 1.66.66, release `c29f265b50a9`, commit `c29f265b50a960aab268892f9614af98a0120d44` on `release/hbots-16664`, working tree clean, result **PASS**.

Machine-readable copy: `releases\c29f265b50a9\gate-evidence.json` (sha256 `b9408a82fab4cde89735101d0168db37d7d07dedd6e4fd434c93ab25f143b6d2`) and the full gate logs in `releases\c29f265b50a9\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2920 tests passed, 0 failed, 4 skipped, in 210 files | 253.7   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 29.5    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2877 tests passed, 0 failed, 0 skipped, in 257 files | 38.1    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 4.2     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 262 checks ok, 0 failed                              | 70.1    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16664\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\c29f265b50a9" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 246.4   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `c29f265b50a960aab268892f9614af98a0120d44`, at end `c29f265b50a960aab268892f9614af98a0120d44`; tracked files modified: none. Staged release: version 1.66.66, sha c29f265b50a9, dirty False, externals copied; `dist/bin.mjs` sha256 `782b9eeb1ba431dc4e6f6974a5fd1d253755896efcc3761f10dcbf1b427b4186`.
<!-- gate-evidence:end -->
