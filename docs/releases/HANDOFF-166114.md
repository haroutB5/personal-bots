# 1.66.114: hbots Android on trunk, shared client package, parity gate

Based on 1.66.113 (`1906a0d1afb6`). Branch `release/hbots-166114`, cut from `feat/hbots-android-trunk` at `8afd29fb1c`. No migration; schema stays 114. Server code is unchanged. `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Why

The Android app lived on a side branch while the phone client and the web app duplicated the same personal-layer code. This release puts both on trunk. One commit now builds the server, the web app and the APK. A parity gate stops the web and Android screens from drifting apart without an owner. No database work, so no backup.

## What changed

- **M1, `@hbots/personal-client`.** The personal layer moves into `packages/personal-client` as a platform-free package. It carries the domain code, ports, test fakes, perf flags and React query and command helpers. A test asserts it touches no browser globals and a type test keeps DOM types out. `apps/web` re-exports the package, so its imports and bundle entry points stay the same. 182 package tests.
- **M2, `apps/hbots-mobile` on trunk.** The Expo Android app and its Kotlin self-updater module are now tracked on `personal-bots/main` rather than a release branch. 164 JS tests and 105 Kotlin tests. `versionName` still comes from `scripts/personal/app-version.txt`, so the APK is built after the version bump.
- **G0, parity gate.** `scripts/personal/parity/parity-matrix.mjs` maps every web screen and personal route to an owner and writes `parity.json`. The gate fails on an unowned screen or a route with no Android counterpart. `gates-linux.json` gains three real release gates: `personal-client`, `hbots-mobile`, `hbots-mobile-kotlin`, plus `parity` pinned with `--client-ref HEAD` so it no longer depends on a remote branch.
- **Release-tool fix.** `hbots-mobile-kotlin` and `parity` were declared with `kind: "check"`, which `gatePass` rejects, so all gates could exit 0 and the evidence still read FAIL. `8afd29fb1c` sets both to `kind: "node"` and pins the parity client ref.

## Rollback

Binary only. The previous release is `1906a0d1afb6` (1.66.113). No migration ran.

## Known and accepted

- Parity route classification keys on the file name under `routes/`, so a new unprefixed personal route can be marked n/a. A planted `_personal` route and an unrouted screen both fail the gate, which is the rule G0 needs. The classifier gap is a follow-up.
- The parity `MERGED_PRS` rule now reads a typed declaration. `--require-done <PR>` remains the explicit check in each plan step.
- The M1 web bundle grows 8,068 bytes of JS (3,285 gzip) against main. Perf was measured within 10 percent. Over the old 2 KB budget, accepted by the lead.
- The parity gate needs a working `vp` formatter. Without it the gate goes red with a format diff, never a false green.
- `pnpm-lock.yaml` repoints 13 shared expo peer snapshots from `apps/mobile` to the same `57.0.18` version for `apps/hbots-mobile`. No version change.
- One e2e run flaked and passed 12/12 on rerun. Root cause unknown.

## Verification

- Verifier round at `82b9f37a0f` passed every product check: the emulator R2 delta, an in-place self-update from 1.66.113 to 1.66.114, web side by side with main, parity plants, and no `apps/server` change. The only blocker was the gate kind, fixed in `8afd29fb1c`. Notes in `/home/harout/Claude/AI/dev-team/qa/hbots-166114-verify/VERDICT-NOTES.md`.
- Gate evidence for this exact commit is recorded below. All nine gates PASS, including `hbots-mobile-kotlin` and `parity`.

## Gate evidence

<!-- gate-evidence:begin -->
<!-- gate-evidence:end -->
