The checked-in runner is installed by DevOps into `%USERPROFILE%/.personal-bots/run`.
Its idle classifier stays in `run/idle-classification-16617.mjs`; that file and its
hash are unchanged. No application build or restart is performed by this folder.

Switch all parts together on the next release:

1. Include the new `backup.ps1`, `sqlite-snapshot.cjs` and `sqlite-check.cjs` in
   the builder's release commit **before** building, gates and focused QA.
2. Let any armed waiter finish. Do not replace its runner or sealed tools.
   Save the installed `run/hbots-release.ps1` and `run/hbots-release/` outside
   those paths, recording their hashes for undo.
3. Copy this folder's `hbots-release.ps1` and `hbots-release/` to `run/` with
   that same layout. Keep the existing idle classifier. The helper hashes are
   pinned in the runner; preserve LF bytes (copy files, do not rewrite them).
4. Run the usual `-Prepare` and `-DryRun` for the new version/notes commit.
   Prepare must archive the **new** `scripts/personal` tree; never edit an
   existing sealed tools copy or reuse an older release's backup scripts.
   Arm through `hbots-release-launch.ps1` after the release passes QA.

The new runner requires a fresh manifest with a full-integrity proof and verifies
the database SHA-256 before restarting. An old backup tool paired with the new
runner fails closed. An old runner with the new backup tool is safe but repeats
the full check, losing the time saving. To undo, restore the saved runner and
helpers together; retain every verified backup and use the ordinary binary-only
release rollback procedure.

Tests from the repo (fake home, no real restart):

```powershell
node --disable-warning=ExperimentalWarning --test scripts/personal/sqlite-snapshot.test.cjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/personal/backup.tests.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/personal/release-runner/hbots-release/tests/hbots-release.tests.ps1
```

An installed copy of the runner tests needs `-ToolsDir <checkout>/scripts/personal`
(or the new sealed tools' `scripts/personal`), since it has no repo-relative tools.

## After 1.66.47: schedulers-OFF guard (fix/hbots-scheduler-switch)

The post-restart log scan (checks B, from the restart offset) now fails the
release, with the usual binary-only rollback, when the server logs
`Personal schedulers are OFF` (`T3CODE_PERSONAL_SCHEDULERS=off`, meant for
restored test copies only). The result JSON gains `schedulersOffLines`. Test:
`s2-schedulersoff` (stub flag `schedulers-off`). No helper changed, so the
runner's helper pins are unchanged. Install hashes for the next release's notes
(sha256, LF bytes):

| File                                                                                           | sha256                                                             |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `hbots-release.ps1`                                                                            | `b1a1bda1d32a1fbdb8b9ac8a2d227cb9a65177e844efe4893e5546f4ffd4766a` |
| `hbots-release/tests/hbots-release.tests.ps1`                                                  | `e8628e77082bb50ecb8c10b32299cab3800ea57b7a2e1fb221da206781ceb998` |
| `hbots-release/tests/stubs/restart.ps1`                                                        | `1561de620d04a3043fb111b615a849404742a144431f3f982a3bac22bd133ad7` |
| `hbots-release/release-db-check.cjs`, `tree-hash.cjs`, `make-fixture.cjs`, `proc-priority.ps1` | unchanged from the 1.66.47 table                                   |

## No-migration releases skip the production backup (24 Oct, after 1.66.89)

Harout's 20 Oct rule ("stop doing backups if it isn't a big release") was in the sheet but never
in the runner: 1.66.89 backed up 3 GB for migration 112 -> 112 and spent 15 minutes on it. The
runner now skips the production backup when `-MigrationBefore` equals `-MigrationAfter` (the
result records `backupSkipped` and `backupDecision: no migration`, the live line says "backup
skipped (no migration)"), and `-ForceBackup` still takes the full backup for a big release with a
stable level. A changed level always backs up exactly as before.

To keep the skip honest the guards (`-Prepare`, `-GuardsOnly`, `-DryRun` and the real run) now
prove two things before anything restarts: the LIVE database's `max(migration_id)` equals
`-MigrationBefore` (new `release-db-check.cjs --live-migration`, a light read-only query, no
integrity walk on the live file), and `apps/server/src/persistence/Migrations.ts` at `-MainSha`
tops out at `-MigrationAfter`. Either mismatch refuses and names both levels. The idle recheck
before restart still runs, and the post-activation memory-row comparison uses the live count read
before the restart as its baseline.

Tests: `s13` (skip run: no backup, live_verified, sheet text) and `s14` (arm below the live level
refuses; source below the level refuses; nothing restarts). The other scenarios run with
`-ForceBackup` so they keep exercising the backup path. Full suite 232 checks, 0 failed (24 Oct).
Fixes two stale expectations while there: `keep-too-low` (BackupKeep 0, the minimum is 1) and
`default1` (the default keeps 1, not 14).

| File                                          | sha256                                                             |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `hbots-release.ps1`                           | `e27eac75107104eca312fb0ad2d8a5d8b45ccb50462700c1ab268c2c5cae3ac6` |
| `hbots-release/release-db-check.cjs`          | `d56ff2d52340b7d518a5b08f5c86f6c7b2fdcc8bd43c784e802a59e2a8655268` |
| `hbots-release/tests/hbots-release.tests.ps1` | `61a063d4f92b09c901aacbf62ea3f97b2d671480df6d4726e37171c2a40dec21` |

## 1.66.48: dry-run backup estimate 160-420 s

The dry run's fresh-backup line now says `160-420 s` (was 160-300 s): QA measured
404.5 s on the busy laptop (15 Oct, 1.66.47), the quiet-disk range stays the low
end. Only the estimate text changed; the runner test `s9` asserts the new range.
No helper changed, so the pins are unchanged. Install hashes for the 1.66.48
notes (sha256, LF bytes); the undo hashes are the 1.66.47 installed runner's
(`6eb7898a...` runner, `b4751b87...` tests, `05ec3dea...` stub `restart.ps1`; the
other helpers unchanged):

| File                                                                                           | sha256                                                             |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `hbots-release.ps1`                                                                            | `9103091263f360313b3900c98467046037825da2af079d95a09b7335b59b0cee` |
| `hbots-release/tests/hbots-release.tests.ps1`                                                  | `4af2581be37190d98e46a972b2f8ea1b9676c1197a095c83d1ab28c84e41511f` |
| `hbots-release/tests/stubs/restart.ps1`                                                        | `1561de620d04a3043fb111b615a849404742a144431f3f982a3bac22bd133ad7` |
| `hbots-release/release-db-check.cjs`, `tree-hash.cjs`, `make-fixture.cjs`, `proc-priority.ps1` | unchanged from the 1.66.47 table                                   |

## 1.66.54: an open voice call is busy

The idle classifier gains the open-call check: an unexpired
`personal_voice_call_leases` row holds the gate, so a landing cannot restart the
app in the middle of a call. It carries 16633's pending-turn check as well, and
a database older than the lease table (or a table that is not there yet) reads
as no calls, never as an error. `updates-common.ps1` carries the same check into
the nightly Updates restart gate.

Install **before `-Prepare`**: `-Prepare` runs `Test-PinnedHelpers`, so the
installed classifier must already match `$PinIdleClassifierSha` in the copied
runner. Copy the classifier **over** `run/idle-classification-16617.mjs`; the
runner keeps that file name.

| File                                                                   | sha256                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `hbots-release.ps1`                                                    | `9149a76e1adcfa28a109da261a51d56e9fcadebf321266377f4f5c857b90935e` |
| `idle-classification-16654.mjs` -> `run/idle-classification-16617.mjs` | `78545adeba7cb03194ef6016e54beaba412895374b826795f8ae79deb75f328d` |
| `hbots-release/tests/`, `hbots-release/*.cjs`, `proc-priority.ps1`     | unchanged from the 1.66.48 table                                   |

To undo, restore the saved 1.66.48 runner and the saved classifier together:
the pin in the runner and the installed classifier hash must agree.
