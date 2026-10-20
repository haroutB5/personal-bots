# HANDOFF 1.66.72

One fix on top of live 1.66.71 (`6e53a91ec1b9`): Install Antigravity failed
on the live server. Built by CTO. No migration (the maximum stays 111);
`PERSONAL_TASKS_CONCURRENCY` stays 5.

Branch `release/hbots-16672`, cut from `release/hbots-16671` at the 1.66.71
notes commit `35a1ef4596`. Code commit `1a99f77df3`.

## 1. Antigravity validation no longer fails on its own cleanup

Live 1.66.71, 20 Oct 06:08 and 06:12 BST, Settings > Providers > Install
Antigravity: "Could not finish the Antigravity installation" both times. The
1.66.71 WARN line gave the cause: `PlatformError: Busy:
FileSystem.makeTempDirectoryScoped (...\Temp\t3-antigravity-validate-*)`,
i.e. removing the validation launch's temporary profile failed, which failed
the whole install before the release was published. Download, extraction and
the validation launch itself succeeded; 0 stalls and 0 ERROR lines in the
live log during both attempts.

Cause: the runtime is a PyInstaller launcher plus a child it starts. The ACP
runtime stops the launcher only; on Windows the child keeps running while it
exits and holds files in its unpack folder (`_MEI*`, inside the validation
profile). Afterwards no process was left and the same folder deleted at once
with the same Node call (checked by CTO on the leftover). Last night's
generic "Could not install" on 1.1.1 was the same failure. On throwaway
servers the timing happened to work (3 of 3 installs).

- Validation records the launcher PID (`onProcessStarted`) and ends its
  descendants with `processTree.terminateDescendants`, as Claude and Codex
  sessions do, in a finalizer added after the runtime so it runs before the
  runtime stops the launcher.
- The validation folder is removed with the lock retries (about a minute)
  and only logs `Antigravity validation folder left behind` if something
  stays; it can no longer fail an install that validated.

Leftovers from the two live attempts were removed by CTO: the validation
folders (their two `skills` junctions into `~/.gemini` pointed at folders
that do not exist; unlinked first, targets untouched) and the staging folder
is swept by the next install.

## 2. Tests

Staged release `1aeb673228da`; gate evidence below PASS (e2e 12/12).
`AntigravityInstallation` and `processTree` tests 42 passed; server
typecheck clean.

CTO throwaway on `1aeb673228da` (evidence `qa/cto-16672/`): enable
Antigravity, Install: "Installed.", v1.4.0, in under a minute; afterwards 0
`agy_acp_server`/`localharness_external` processes, its
`t3-antigravity-validate-*` folder removed (the count in %TEMP% stayed at the
one older leftover), `versions/` holds only the release, and the server log
has 0 `Antigravity install failed`, 0 `validation folder left behind`, 0
stalls. The live failure did not reproduce on throwaways before the fix
either (timing), so the proof that matters is the live install after this
ships; CTO does it as the live check. Small contained fix: builder proof
only, no QA run (handbook tiers).

## 3. Risks

- Contained to the installer's validation step. Sessions and sign-in are
  unchanged (they may leave the same child running briefly when stopped;
  follow-up, not this release).
- `terminateDescendants` kills by PID only, children created after the
  launcher (handbook rule), never by name.

## Gate evidence

<!-- gate-evidence:begin sha=1aeb673228daf1c853013c3a15edb85b920ab8c1 release=1aeb673228da json-sha256=4a255bd6294ea9204c45f385963b6b27a5164c76715532b71372438f70d09a95 result=PASS -->

Written by `scripts/personal/gate-evidence.ps1` at 2026-10-20T05:24:51Z. Version 1.66.72, release `1aeb673228da`, commit `1aeb673228daf1c853013c3a15edb85b920ab8c1` on `release/hbots-16672`, working tree clean, result **PASS**.

Machine-readable copy: `releases\1aeb673228da\gate-evidence.json` (sha256 `4a255bd6294ea9204c45f385963b6b27a5164c76715532b71372438f70d09a95`) and the full gate logs in `releases\1aeb673228da\gate-evidence-logs\`. `check-gate-evidence.ps1` (release waiter, before arming) refuses a release whose evidence is missing, failed or recorded for another commit, and one with code changes after this commit; only `docs/releases` may change after it.

| Gate         | Commands                                                                                                                                                                                                                                                                                                               | Exit | Result                                                     | Seconds |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------- |
| server-tests | `vp test run src/personal src/mcp` (in `apps\server`)                                                                                                                                                                                                                                                                  | 0    | pass: 2941 tests passed, 0 failed, 4 skipped, in 213 files | 263.6   |
| server-tsc   | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\server`)                                                                                                                                                                                                                                                              | 0    | pass: exit code only                                       | 32.7    |
| web-tests    | `vp test run --project unit src/features/personal` (in `apps\web`)                                                                                                                                                                                                                                                     | 0    | pass: 2882 tests passed, 0 failed, 0 skipped, in 257 files | 34.5    |
| web-tsc      | `..\..\node_modules\.bin\tsc --noEmit` (in `apps\web`)                                                                                                                                                                                                                                                                 | 0    | pass: exit code only                                       | 7.5     |
| ps-tests     | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\release-safety.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\gate-evidence.tests.ps1`; `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\personal\updates\updates.tests.ps1` (in `.`) | 0    | pass: 275 checks ok, 0 failed                              | 66.9    |
| e2e          | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude\AI\_wt\hbots-16670\scripts\personal\e2e-smoke.ps1" -Release "C:\Users\Ht\.personal-bots\releases\1aeb673228da" -Json` (in `.`)                                                                                                                     | 0    | pass: 12/12 journeys passed                                | 264.7   |

E2E journeys: `bots-list-chat` ok, `new-chat-named` ok, `delegate-task` ok, `chats-search` ok, `long-press-reply` ok, `continue-chat` ok, `offline-queue` ok, `offline-network` ok, `cold-load-drop` ok, `offline-screens` ok, `stale-deploy` ok, `revoked-session` ok.

Tree: HEAD at start `1aeb673228daf1c853013c3a15edb85b920ab8c1`, at end `1aeb673228daf1c853013c3a15edb85b920ab8c1`; tracked files modified: none. Staged release: version 1.66.72, sha 1aeb673228da, dirty False, externals copied; `dist/bin.mjs` sha256 `8faf0c403f098a31d2e7a73b4e145090e142891f3f1f8b0f7bd65e9f99607cb6`.
<!-- gate-evidence:end -->
