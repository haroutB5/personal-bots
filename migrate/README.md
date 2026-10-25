# Omarchy migration scripts

These are the Windows-side capture and USB tools and the Linux-side bootstrap and
verification for moving the hbots laptop from Windows to Omarchy. The plan of
record is `C:/Claude/AI/dev-team/plans/omarchy-migration.md`.

Everything destructive is dry-run by default and needs an explicit switch plus a
typed confirmation. Nothing here prints or stores a secret value.

## Files

| File | Runs on | Purpose |
| --- | --- | --- |
| `windows/prewipe.ps1` | Windows PowerShell 5.1 | Stop hbots, copy `C:\Claude`, `%USERPROFILE%\.personal-bots`, `~\.ssh` and `~\.cloudflared`, verify SHA256, inventory the machine |
| `windows/make-installer.ps1` | Windows PowerShell 5.1 | Verify the Omarchy ISO against the published SHA256 and, when asked, write the ISO stick. ISO only: no answer file, no second stick |
| `linux/enable-ssh.sh` | Omarchy (Arch) | Print (or apply) the one-line first-login command that enables sshd and adds the team's public keys |
| `linux/bootstrap.sh` | Omarchy (Arch), root over SSH | Restore data, install packages and units with the path map, import secrets, start hbots, open firewall ports, set update policy, run verify |
| `linux/verify.sh` | Omarchy | Read-only PASS/FAIL health table, `--json` optional |
| `tests/run-tests.mjs` | Windows or Linux, Node 24 | Offline tests for all of the above |

## prewipe.ps1

Default is a dry run. It prints the data scope, the copy plan, the hash plan,
the inventory plan and a free-space gate, then exits without writing.

```
powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\prewipe.ps1
```

Real run:

```
powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\prewipe.ps1 -Apply -StopServer
```

Then type `WIPE-LAPTOP-CONFIRMED` exactly. `-Apply` alone is not enough.

- `-Target` defaults to `\\GAMINGPC\Backups\omarchy-migration`. Override it with
  a local drive or another share. The script refuses a target on `C:` and a
  target on the same physical disk as C:.
- `-StopServer` calls the existing `scripts/personal/stop.ps1` and waits for
  port 38472 to close. Without it the SQLite database can be copied mid-write;
  the script warns but still runs if you choose that.
- `-Scope Full` (default) copies `C:\Claude`, `C:\Users\Ht\.personal-bots`,
  `~\.ssh` and `~\.cloudflared`. `-Scope Small -FixtureRoot <dir>` copies and
  hashes only a fixture tree, for tests; it never touches a real profile.
- `-FullImage` also takes a VSS-consistent `wbadmin` image of C: before the
  copies, using `wbadmin start backup -backupTarget:<target> -include:C:
  -allCritical -quiet`. It is off by default. Harout's 25 Oct decision is to
  keep only the data hbots needs, not the whole Windows install, so the default
  is data-only. If you enable it, Windows Server Backup must be installed and
  the target must not be C: or the same physical disk; a UNC target works for
  file recovery but bare-metal recovery wants a disk in the gaming PC.
- Regenerable folders are excluded and listed in the inventory: `node_modules`,
  `dist`, `build`, `out`, `.next`, `.turbo`, `.venv`, `__pycache__`, `.cache`,
  `.pnpm-store`, `playwright-browsers`, `coverage`, `backups`, `runtimes` and
  `workspace`. From `.personal-bots\releases`, only the release named by
  `current.txt` is copied; older release folders are left behind and listed.
- The copy is `robocopy /E /COPY:DAT /XJ /XD ...` plus a full source-to-copy
  SHA256 comparison and a CSV manifest under `<target>\inventory\hash-*.csv`.
  Junction points are skipped (`/XJ`), matching the verification walk.
- Inventory goes to `<target>\inventory`: winget list, node/npm/pnpm/git/python
  versions, scheduled tasks, inbound firewall allow rules, listening ports,
  Brave profile folders, system info, ipconfig, routes and `left-behind.txt`.
- `.env` files and `secrets\` contents are copied as opaque bytes and hashed,
  but never opened, parsed or printed. Manifests hold names and hashes only.
  `~\.ssh` and `~\.cloudflared` contain private keys and tunnel credentials;
  they are copied only because the Linux host needs them, and the target copy
  must be protected like the originals.

Free-space estimate: the included file sizes times 1.10, measured with the same
exclusions as the copy. With `-FullImage`, the used bytes of C: are added before
the margin. Apply uses the same number as its gate. If the target is an unmapped
UNC path the free space is reported as unknown; pass the mapped drive path (for
example `Z:\omarchy-migration`) if you want the check to run against the share.

## make-installer.ps1

ISO only. Harout's Omarchy installer stick is already written and verified from
`C:/Users/Ht/Downloads/omarchy/`, and he answers the installer's few questions
himself. This script is now the verification and recovery path: check the ISO,
and rewrite the stick only if it is lost or damaged. The old second stick and
answer file are gone.

Default is a dry run. It resolves the current Omarchy version from the GitHub
release, fetches the published checksum, lists every disk with model, size,
bus, system flag and partition count, and prints what it would write.

```
powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\make-installer.ps1
```

Real run:

```
powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\make-installer.ps1 -Apply -IsoDiskNumber 3 -EraseDisk
```

Type that stick's exact model string when prompted. The script refuses the
system disk, the disk holding C:, and any disk holding this repo. A non-USB bus
is refused unless `-AllowFixed` is passed; that flag is only for a throwaway
image-file test.

### ISO verification

The version and checksum source of truth at the time of writing (25 Oct 2026):

- latest release: `https://api.github.com/repos/omacom/omarchy/releases/latest`
- ISO: `https://iso.omarchy.org/omarchy-<version>.iso`
- checksum: `https://iso.omarchy.org/omarchy-<version>.iso.sha256`

The script downloads to `<path>.partial`, checks SHA256 against the published
file, and only then moves it into place. A mismatch is reported and the partial
file is left for you to remove; the script never deletes it for you. An existing
ISO is reused only when it matches the published checksum. The published GPG
signature is a stronger check; see the omarchy-iso README if you want to verify
it manually with `gpg --verify`.

### Test modes

```
# offline test suite (never prompts, never touches real media)
powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\make-installer.ps1 -SelfTest
```

`-ImageFile` is the full-flow test switch: with it, the ISO is written to a
plain file instead of a physical disk.

## First login: SSH access

A fresh Omarchy install does not enable sshd. `enable-ssh.sh` prints one line
that Harout pastes in a terminal at the laptop on first login. It installs
openssh, enables and starts sshd, adds the team's public keys to
`~/.ssh/authorized_keys`, opens port 22 when a local firewall is active, and
prints the LAN address.

```
bash migrate/linux/enable-ssh.sh            # print the one-liner (default)
bash migrate/linux/enable-ssh.sh --apply    # run it here, on this machine
bash migrate/linux/enable-ssh.sh --keys extra.pub
```

The line carries public keys only. From the gaming PC:

```
ssh -i C:\Users\harou\.ssh\hbots-migrate_ed25519 harout@<printed-ip>
```

The keys trusted on the laptop are `hbots-cto@laptop` and
`hbots-migrate@gamingpc`. Add more with `--keys <file.pub>`; never add a
private key.

## bootstrap.sh

Run as root over SSH after the first Omarchy boot, the laptop is on the network
and the `enable-ssh.sh` one-liner has been pasted. Both modes are explicit;
there is no implicit apply.

```
./bootstrap.sh --dry-run --source /mnt/gamingpc/omarchy-migration/plain
./bootstrap.sh --apply   --source /mnt/gamingpc/omarchy-migration/plain
```

Options:

- `--source PATH`: restore root. Default `/mnt/gamingpc/omarchy-migration/plain`.
  It must contain `Claude/` and `personal-bots/`, which is exactly what
  `prewipe.ps1` writes under `<target>\plain`. An rsync-over-SSH source such as
  `harout@gamingpc:/srv/omarchy-restore/plain/` also works.
- `--repo PATH`: default `<home>/Claude/AI/personal-bots`
- `--data-dir PATH`: default `<home>/.personal-bots`
- `--user NAME`: default `$SUDO_USER`, else `harout`
- `--secrets-bundle PATH`: default `<home>/omarchy-secrets.bundle`
- `--skip-restore`, `--skip-packages`, `--skip-secrets`, `--skip-start`,
  `--skip-verify`: only for repair runs or a base-host proof.
- `--allow-arch-only`: proof-only switch for plain Arch (WSL); it keeps the Arch
  check and permits the missing Omarchy marker. Never use it on install night.

The script never deletes: rsync runs without `--delete`, and no cleanup step is
destructive.

The start step refuses to run when something else already answers on 38472,
then waits for `hbots.service` to be active and healthy, so a stale manual
server cannot be mistaken for a successful unit start.

Order inside the script is the order on install night: SSH check, OS check,
restore, packages, units with the path map, secrets import, start hbots,
firewall, update policy, verify.

### Path rewrite (Backend migration 113)

Backend replaced the separate `migrate-paths.mjs` with server migration 113.
On the first Linux boot it rewrites `projection_projects.workspace_root` and
`favicon_path`, `projection_threads.worktree_path`, and the matching event
payloads, using `T3CODE_PATH_MAP`. The bootstrap renders this into
`hbots.service` before anything starts:

```
T3CODE_PATH_MAP=C:/Users/Ht=<home>;C:/Claude/AI=<home>/Claude/AI
```

The migration is recorded as applied on that first boot. If the server ever
boots without the map, the log says
`T3CODE_PATH_MAP is not set; no stored paths rewritten.` and the paths stay
Windows-shaped; restore the copied DB and boot again with the map set. The
bootstrap refuses to finish if the deployed unit lacks the mapping, and it fails
the start step if that warning appears in the journal.

### Secrets import

The sealed bundle is imported with Backend's CLI:

```
node <release>/bin.mjs secrets import --secrets-dir <data>/dev/userdata/secrets --in <bundle>
```

The passphrase comes from `HBOTS_SECRETS_PASSPHRASE`, or one line on stdin, and
never from an argument. When bootstrap runs interactively it prompts with
`read -rs`; over a non-interactive SSH session it prints the exact command for
Harout to run at the laptop terminal instead of pretending the import happened.
Secret values are never printed.

### Units and packages

The bootstrap calls `scripts/personal/linux/install-units.sh` with `--repo`,
`--ai-dir`, the pinned `--node` and `--path-map`, then sets
`loginctl enable-linger`. If the installer is absent, the step warns and
continues.

It syncs the package database once (`pacman -Sy --noconfirm`) and installs
`base-devel git python nodejs rsync cloudflared lm_sensors ollama`, then mise
(`mise-bin` on Omarchy, `mise` on plain Arch, or an existing mise), then as the
user:

- `mise install node@24.22.1` and `mise use -g node@24.22.1`
- `mise use -g pnpm@11.10.0` (no corepack dependency)
- `brave-bin` from the Omarchy repository when it is there, otherwise from the
  AUR through `yay` or `paru`

If brave is in neither place or no AUR helper is installed, it is reported as a
manual step instead of half-installing it. Everything else is fatal on failure.

### Firewall

Only the active backend is touched:

- ufw active: `ufw allow <port>/tcp comment hbots`
- firewalld active: permanent port entries plus reload
- nftables active and neither of the above: a dedicated `inet hbots` table,
  plus `/usr/local/bin/hbots-firewall` and `hbots-firewall.service` so the
  rules survive reboot. Existing nftables configuration is not edited.
- none active: nothing is opened, and the script says so.

Ports: 38472 hbots, 5186 Kino, 8765 docs server.

### Updates

Unattended upgrades stay off. The script disables `pacman-auto-update.timer` and
`unattended-upgrades.service` only if they are enabled. It prints:

```
sudo snapper -c root create --description pre-update
omarchy-update
```

Use the Omarchy menu snapshot entry or `omarchy-snapshot` if snapper is not
available.

## verify.sh

```
./verify.sh
./verify.sh --json
./verify.sh --user harout --repo /home/harout/Claude/AI/personal-bots
./verify.sh --skip-apps
```

Checks:

- every `scripts/personal/linux/systemd/*.service` (or `.service.in`) is installed
  under `~/.config/systemd/user` and active as the user; a unit whose systemd
  condition is not met (its app is not restored yet) is SKIP, not FAIL
- `T3CODE_PATH_MAP` in the installed `hbots.service` maps both `C:/Users/Ht` and
  `C:/Claude/AI`, because migration 113 only runs once, on the first boot
- hbots answers `GET http://127.0.0.1:38472/.well-known/t3/environment`
- Kino answers on 5186 and the docs server on 8765; if the app directory is not
  restored yet, that check is SKIP
- `sensors` is installed
- cloudflared: PASS when a tunnel process or a user/system unit is active,
  otherwise SKIP because hbots starts its own tunnel once T3 Connect is linked
- at least 5 GiB free on `/`

Exit 0 only when no check is FAIL. `--json` emits
`{"ok":...,"dryRun":...,"user":...,"repo":...,"checks":[...]}`. `--dry-run`
prints the checks as SKIP and exits 0 without probing. `--skip-apps` reports
Kino and docs as SKIP, for a base-host check before those apps are restored.

## Install night: order of operations

1. On Windows, run `prewipe.ps1` dry. Read the target, the estimate and the disk
   list. Fix the target or free space before going on.
2. Run `prewipe.ps1 -Apply -StopServer`, type `WIPE-LAPTOP-CONFIRMED`, and wait
   for the data copies, the hash manifests and the inventory.
   `-StopServer` stops the app that hosts the bots, so start this step from a
   normal PowerShell window or a detached task, not from a bot session you need
   to keep alive.
3. Optional: run `make-installer.ps1` dry to confirm the ISO that is already on
   Harout's stick matches the published SHA256. Rewrite the stick only if it
   needs it.
4. Plug the Omarchy stick into the laptop.
5. At power-on, press F2, turn Secure Boot off, save and exit. Press F12 and
   boot the ISO stick.
6. Answer the installer's few questions. It wipes the internal disk and reboots
   into Omarchy.
7. On first login, paste the one line printed by `enable-ssh.sh`.
8. From the gaming PC, SSH in as `harout` with
   `-i C:\Users\harou\.ssh\hbots-migrate_ed25519`. Run
   `bootstrap.sh --dry-run --source <restore path>` first, then
   `bootstrap.sh --apply --source <restore path>`.
9. Run `verify.sh` if the bootstrap did not already. Fix any FAIL before handing
   the laptop over.
10. Re-approve the provider sign-ins from links on the phone: Claude, Codex,
    OpenCode, Antigravity, GitHub, Vercel, Cloudflare. Keep the data copy and its
    manifests on the gaming PC for at least one week.

## Manual steps that stay with Harout

- Plug in the Omarchy USB stick (already written).
- F2 at power-on: Secure Boot off.
- F12: boot the ISO stick.
- Answer the installer's questions, including the disk password if he enables
  encryption.
- Paste the `enable-ssh.sh` one-liner at first login.
- Approve provider sign-ins from the links on his phone.

## Safety notes

- No secret values in files, logs, commits or chat. The laptop's
  `authorized_keys` carries public keys only.
- `-Apply` plus a typed confirmation is required for every destructive action.
  There are no force flags and no `-Yes`.
- The scripts never delete data. An existing ISO with a bad hash is left in
  place for the operator to remove.
- The data copy and its manifests are kept on the gaming PC for at least one
  week after Omarchy is live. There is no Windows system image by default; pass
  `-FullImage` if you want the wbadmin capture as well.

## Tests

From the repo root on Windows:

```
node migrate/tests/run-tests.mjs
```

The suite runs both PowerShell self-tests (they SKIP on a Linux host without
Windows PowerShell), proves `make-installer.ps1` is
ISO-only, checks the `enable-ssh.sh` one-liner and its keys, runs `bash -n` and
`shellcheck` (when installed) on every shell script, runs
`bootstrap.sh --dry-run` plus `verify.sh --dry-run` and `--json` against a temp
directory, and proves `verify.sh` exits 0 and 1 with fake healthy and broken
services.
