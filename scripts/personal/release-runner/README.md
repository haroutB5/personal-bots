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
