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

PROOF_PLACEHOLDER

## 3. Risks

- Contained to the installer's validation step. Sessions and sign-in are
  unchanged (they may leave the same child running briefly when stopped;
  follow-up, not this release).
- `terminateDescendants` kills by PID only, children created after the
  launcher (handbook rule), never by name.
