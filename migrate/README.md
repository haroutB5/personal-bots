# Omarchy migration scripts

These are the Windows-side capture and USB tools and the Linux-side bootstrap and
verification for moving the hbots laptop from Windows to Omarchy. The plan of
record is `C:/Claude/AI/dev-team/plans/omarchy-migration.md`.

Everything destructive is dry-run by default and needs an explicit switch plus a
typed confirmation. Nothing here prints or stores a secret value.

## Files

| File | Runs on | Purpose |
| --- | --- | --- |
| `windows/prewipe.ps1` | Windows PowerShell 5.1 | Stop hbots, image C: with wbadmin, copy `C:\Claude` and `%USERPROFILE%\.personal-bots`, verify SHA256, inventory the machine |
| `windows/make-installer.ps1` | Windows PowerShell 5.1 | Download and verify the Omarchy ISO, write the ISO stick, build and write the CIDATA stick |
| `linux/bootstrap.sh` | Omarchy (Arch), root over SSH | Restore data, rewrite paths, import secrets, install packages and units, open firewall ports, set update policy, run verify |
| `linux/verify.sh` | Omarchy | Read-only PASS/FAIL health table, `--json` optional |
| `tests/run-tests.mjs` | Windows or Linux, Node 24 | Offline tests for all of the above |

## prewipe.ps1

Default is a dry run. It prints the wbadmin command, the copy plan, the hash
plan, the inventory plan and a free-space gate, then exits without writing.

```
powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\prewipe.ps1
```

Real run:

```
powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\prewipe.ps1 -Apply -StopServer
```

Then type `WIPE-LAPTOP-CONFIRMED` exactly. `-Apply` alone is not enough.

- `-Target` defaults to `\\GAMINGPC\Backups\omarchy-migration`. Override it with
  a local drive or another share. A UNC target is fine for wbadmin file
  recovery; bare-metal recovery needs a disk physically attached to the gaming
  PC, so prefer a local volume on the gaming PC for the image. The script
  refuses a target on `C:`.
- `-StopServer` calls the existing `scripts/personal/stop.ps1` and waits for
  port 38472 to close. Without it the SQLite database can be copied mid-write;
  the script warns but still runs if you choose that.
- `-Scope Full` (default) images C: and copies the two real trees. `-Scope Small
  -FixtureRoot <dir>` copies and hashes only a fixture tree, for tests. Small
  never touches a real profile and never runs wbadmin; it copies the fixture
  only.
- `-SelfTest` runs argument validation, a copy/hash round trip, tamper
  detection, a C: target refusal, overlap refusal and confirmation checks in
  `%TEMP%`, then exits 0 or 1.
- The image uses `wbadmin start backup -backupTarget:<target> -include:C:
  -allCritical -quiet`, which is VSS-consistent. If `wbadmin.exe` is missing
  (some Windows Home editions), apply fails with a clear message instead of
  pretending a plain file copy is a system image.
- The plain copy is `robocopy /E /COPY:DAT /XJ` plus a full source-to-copy
  SHA256 comparison and a CSV manifest under `<target>\inventory\hash-*.csv`.
  Junction points are skipped (`/XJ`), matching the verification walk.
- Inventory goes to `<target>\inventory`: winget list, node/npm/pnpm/git/python
  versions, scheduled tasks, inbound firewall allow rules, listening ports,
  Brave profile folders, system info, ipconfig, routes and global git config.
- `.env` files and `secrets\` contents are copied as opaque bytes and hashed,
  but never opened, parsed or printed. Manifests hold names and hashes only.

Free-space estimate: C: used bytes times 1.25 plus 10 GB. This covers the image
and the plain copies with margin without walking millions of files during a dry
run. Apply uses the same number as its gate. If the target is an unmapped UNC
path the free space is reported as unknown; check the share before apply.

## make-installer.ps1

Default is a dry run. It resolves the current Omarchy version from the GitHub
release, fetches the published checksum, lists every disk with model, size,
bus, system flag and partition count, and prints what it would write.

```
powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\make-installer.ps1
```

Real run:

```
powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\make-installer.ps1 -Apply -IsoDiskNumber 3 -CidataDiskNumber 4 -EraseDisk
```

For each stick, type that stick's exact model string when prompted. The script
refuses the system disk, the disk holding C:, and any disk holding this repo. A
non-USB bus is refused unless `-AllowFixed` is passed; that flag is only for a
throwaway image-file test.

### Two sticks are required

The Omarchy ISO is written raw to the whole device. That destroys any second
partition on the same stick, so the supported layout is two sticks:

1. stick 1: the ISO, at least 8 GB
2. stick 2: a small FAT32 volume labelled `CIDATA`, 64 MB is enough

Omarchy looks for `/dev/disk/by-label/cidata` on a second drive. A partition on
the same stick is not supported by this flow. Do not try to save a stick by
combining them.

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

### cidata

`user_configuration.json` matches the configurator output used by the Omarchy
ISO integration tests, including the `omarchy_install` block:

- disk: full disk wipe, one 2 GiB FAT32 ESP at `/boot`, the rest Btrfs with
  `@`, `@home`, `@log`, `@pkg`
- device: `/dev/nvme0n1` by default; `-DiskDevice` overrides it
- size: 512110190592 bytes by default; pass `-DiskBytes` with the exact
  `lsblk -b -dn -o SIZE /dev/nvme0n1` value if the disk differs
- hostname, timezone (`Europe/London`), keyboard (`gb`), locale
- packages `base-devel`, `git`, `omarchy-keyring`, `omarchy-settings`,
  `omarchy`
- no encryption block, and `user_encrypt_installation.txt` is `false`

`user_credentials.json` carries the username and one SHA-512 crypt hash for both
root and the user. The password is typed into `Read-Host -AsSecureString`, sent
to `openssl.exe passwd -6 -stdin` on stdin (never argv), and only the `$6$...`
hash is written. On this machine openssl comes from Git for Windows at
`C:\Program Files\Git\usr\bin\openssl.exe`.

`authorized_keys` is required and must contain the CTO laptop and gaming PC
public keys, one per line. The default path is
`%USERPROFILE%\.ssh\authorized_keys`; pass `-AuthorizedKeysPath` or create the
file first. An empty file is refused because Omarchy fails an unattended
install whose key file is empty.

The script also writes a plain `hostname` file containing the hostname. Omarchy's
documented loader does not read that file; the effective hostname is the
`hostname` key in `user_configuration.json`. The extra file is informational and
is safe on the cidata volume.

`user_configuration.json` is the archinstall schema, not a custom one. The
`version` field is the archinstall config version (`3.0.9` in the Omarchy 4.0.6
harness). If Omarchy changes that schema, update this script against a fresh
interactive install's `/root/user_configuration.json`.

### Test modes

```
# cidata only, dry run, then apply to a plain image file
powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\make-installer.ps1 -BuildCidataOnly -ImageFile C:\Temp\cidata.img
powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\make-installer.ps1 -BuildCidataOnly -ImageFile C:\Temp\cidata.img -Apply

# offline test suite (never prompts, never touches real media)
powershell -NoProfile -ExecutionPolicy Bypass -File migrate\windows\make-installer.ps1 -SelfTest
```

`-ImageFile` is the full-flow test switch for the ISO: with it, the ISO is
written to a plain file instead of a physical disk. In full-flow test mode the
cidata image defaults to `<ImageFile>.cidata.img`; `-CidataImage` overrides it.
Tests use `-BuildCidataOnly -ImageFile ... -SelfTest` so no real media is
touched.

## bootstrap.sh

Run as root over SSH after the first Omarchy boot and after the laptop is on the
network. Both modes are explicit; there is no implicit apply.

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
- `--skip-restore`, `--skip-packages`, `--skip-verify`: only for repair runs

The script never deletes: rsync runs without `--delete`, and no cleanup step is
destructive.

Order inside the script is the order on install night: OS check, restore, path
rewrite, secrets import, packages, units, firewall, update policy, verify.

### Interfaces expected from Backend

The bootstrap calls these when present and says exactly what is missing when
not:

- path rewrite: `scripts/personal/node/migrate-paths.mjs`, invoked as
  `node migrate-paths.mjs --data-dir <dir> --repo <dir> --apply`. If the file is
  absent, apply stops before packages. This is deliberate: running on
  unrewritten Windows paths is worse than stopping.
- secrets import: one of
  `scripts/personal/node/secrets-import.mjs`,
  `scripts/personal/node/import-secrets.mjs`, or
  `migrate/linux/import-secrets.sh`, invoked with `--bundle <path> --data-dir
  <dir>` (or the bundle as the first argument for the shell version). The
  importer prompts for its passphrase itself; the bootstrap never sees it.
  If no importer is present, the step warns and continues so the rest of the
  machine can still be verified. Re-approve provider logins afterwards.
- units: `scripts/personal/linux/systemd/install-units.sh`. If absent, the step
  warns and continues. `loginctl enable-linger` is set when the installer is
  present.

### Packages

`pacman -S --needed --noconfirm base-devel git python nodejs mise rsync
cloudflared lm_sensors ollama`, then as the user:

- `mise install node@24.22.1` and `mise use -g node@24.22.1`
- `corepack enable` and `corepack prepare pnpm@11.10.0 --activate`
- `brave-bin` from the AUR through `yay` or `paru`

If no AUR helper is installed, brave is reported as a manual step instead of
half-installing it. Everything else is fatal on failure.

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
```

Checks:

- every `scripts/personal/linux/systemd/*.service` is active as the user
- hbots answers `GET http://127.0.0.1:38472/.well-known/t3/environment`
- Kino answers on 5186 and the docs server on 8765
- `sensors` is installed
- cloudflared has an active user or system unit
- at least 5 GiB free on `/`

Exit 0 only when every check passed. `--json` emits
`{"ok":...,"dryRun":...,"user":...,"repo":...,"checks":[...]}`. `--dry-run`
prints the checks as SKIP and exits 0 without probing.

## Install night: order of operations

1. On Windows, run `prewipe.ps1` dry. Read the target, the estimate and the disk
   list. Fix the target or free space before going on.
2. Run `prewipe.ps1 -Apply -StopServer`, type `WIPE-LAPTOP-CONFIRMED`, and wait
   for the image, both plain copies, the hash manifests and the inventory.
3. Run `make-installer.ps1` dry. Confirm the Omarchy version, the published
   SHA256 and the two USB sticks in the disk table.
4. Run `make-installer.ps1 -Apply -IsoDiskNumber <n> -CidataDiskNumber <m>
   -EraseDisk` and type each stick's model. Plug both sticks into the laptop.
5. At power-on, press F2, turn Secure Boot off, save and exit. Press F12 and
   boot the ISO stick, with the CIDATA stick still plugged in.
6. The installer wipes the internal disk and installs with no wizard. It also
   installs `authorized_keys`, enables sshd and opens SSH in ufw. It reboots
   into Omarchy by itself.
7. From the gaming PC or CTO laptop, SSH in as `harout`. Run
   `bootstrap.sh --dry-run --source <restore path>` first, then
   `bootstrap.sh --apply --source <restore path>`.
8. Run `verify.sh` if the bootstrap did not already. Fix any FAIL before handing
   the laptop over.
9. Re-approve the provider sign-ins from links on the phone: Claude, Codex,
   OpenCode, Antigravity, GitHub, Vercel, Cloudflare. Keep the Windows image on
   the gaming PC for at least one week.

## Manual steps that stay with Harout

- Plug in the two USB sticks the bots prepare.
- F2 at power-on: Secure Boot off.
- F12: boot the ISO stick.
- Type the disk password at first boot only if encryption was enabled. This
  script does not enable LUKS; if you add it, the LUKS passphrase prompt is the
  one step that cannot be unattended.
- Approve provider sign-ins from the links on his phone.
- Do not unplug the CIDATA stick until the installer has rebooted into Omarchy.

## Safety notes

- No secret values in files, logs, commits or chat. The cidata volume carries
  only a password hash and public keys.
- `-Apply` plus a typed confirmation is required for every destructive action.
  There are no force flags and no `-Yes`.
- The scripts never delete data. An existing ISO with a bad hash is left in
  place for the operator to remove.
- The full image is kept on the gaming PC for at least one week after Omarchy is
  live.

## Tests

From the repo root on Windows:

```
node migrate/tests/run-tests.mjs
```

The suite runs both PowerShell self-tests, builds a CIDATA image and reads it
back with an independent FAT32 reader, checks JSON keys and the absence of the
plaintext test password, runs `bash -n` and `shellcheck` (when installed) on both
shell scripts, and runs `bootstrap.sh --dry-run` plus `verify.sh --dry-run` and
`--json` against a temp directory.
