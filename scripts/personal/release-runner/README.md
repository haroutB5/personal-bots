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
