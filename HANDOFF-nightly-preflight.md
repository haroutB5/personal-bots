# HANDOFF: nightly Claude Code update preflight (5 Oct 2026)

Branch `fix/nightly-preflight-1005`, scripts and README only (`scripts/personal/updates/`). No server bundle change,
so no release build is needed: these scripts run from the main checkout. Not merged to `personal-bots/main`.
Merging is a fast-forward; then fast-forward the main checkout (`git -C C:/Claude/AI/personal-bots merge --ff-only
origin/personal-bots/main`) because the old preflight in it cannot heal itself. Tonight's 04:00 run needs both.

Why every preflight stopped from 26 Sep: the live-release check compared the whole tree and the team's
`HANDOFF-<n>.md` commit on top of each release always failed it; the trunk was hardwired to `fix/inline-cards`; the main
checkout sat on that branch (1.42.0) with the 25 Sep node_modules. 5 Oct had no run only because there was nothing to do.

What changed: trunk `personal-bots/main`; only paths a release is built from count (top-level `*.md`, `docs/`,
`scripts/personal/` except `app-version.txt` may differ); a behind-only checkout is fast-forwarded; a live run reinstalls
node_modules when the lockfile moved; the build detector ignores shells that only name a script; `PB_UPDATES_NO_REPORT=1`
for rehearsals. Tests: `updates.tests.ps1` (81 checks). Evidence and the dry-run table:
`C:/Users/Ht/.personal-bots/qa/nightly-preflight-1005/RESULT.md`.

Left alone on purpose: the Updates bot's instruction text in `reviewPrompts.ts` still says "live release branch
fix/inline-cards" (prose only; changing it is a server change); the pipeline's restart waits only for the Updates bot's
task, not for other bots' work.
