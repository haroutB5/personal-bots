#!/usr/bin/env bash
#
# first-login.sh - the one paste from Harout on first Omarchy login.
#
# It is run from the external SSD by the line in PASTE.txt (also written to
# the SSD as PASTE-ME.txt). It does everything else by itself:
#
#   1. verify the external SSD by model and serial, mounted READ-ONLY
#   2. verify every payload file against payload.sha256
#   3. enable sshd and add the team's public keys (so the team can watch)
#   4. run bootstrap.sh --apply against the SSD's restore copy, which installs
#      packages and units, imports the sealed secrets (it prompts once, here at
#      the laptop, for Harout's passphrase), starts hbots and runs verify.sh
#   5. print one clear SUCCESS or FAILURE message, leave a log and a status
#      file, and unmount the SSD so Harout can unplug it
#
# Nothing is passed on the command line that is secret. The passphrase is read
# with `read -rs` by bootstrap.sh and is never echoed, logged or put in argv.
#
# Usage:
#   bash first-login.sh                 # apply (root; the normal path)
#   bash first-login.sh --check-only    # verify SSD and payload, change nothing
#   bash first-login.sh --print-line    # print the one pasteable line
#
# Test-only switches:
#   --skip-volume-check   do not require the SanDisk model/serial (fake mounts)
#   --mount PATH          mount point to use (default /mnt/hbots-backup)
#   --source PATH         restore root override (default <mount>/plain)
#   --no-ssh              do not enable sshd
#   --keep-mounted        leave the SSD mounted at the end (debugging)
#
set -euo pipefail

MOUNT_POINT="${HBOTS_BACKUP_MOUNT:-/mnt/hbots-backup}"
EXPECTED_MODEL="${HBOTS_SSD_MODEL:-SanDisk Extreme}"
EXPECTED_SERIAL="${HBOTS_SSD_SERIAL:-2306CQ402457}"
MODE=apply
SKIP_VOLUME_CHECK=0
KEEP_MOUNTED=0
ENABLE_SSH=1
SOURCE_OVERRIDE=""
TARGET_USER_OVERRIDE=""
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
STATUS_FILE="/var/log/hbots-first-login.status"

usage() {
  sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
  printf '\nFAILED: %s\n' "$*" >&2
  if [ -n "${LOG_FILE:-}" ]; then
    printf 'Log: %s\n' "$LOG_FILE" >&2
  fi
  write_status failed "$*"
  exit 1
}

info() {
  printf '    %s\n' "$*"
}

log() {
  printf '\n==> %s\n' "$*"
}

write_status() {
  local state="$1" detail="${2:-}"
  [ -n "${LOG_FILE:-}" ] || return 0
  {
    printf 'state=%s\n' "$state"
    printf 'at=%s\n' "$(date -Is)"
    printf 'log=%s\n' "$LOG_FILE"
    [ -n "$detail" ] && printf 'detail=%s\n' "$detail"
  } > "$STATUS_FILE" 2>/dev/null || true
  chmod 600 "$STATUS_FILE" 2>/dev/null || true
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --print-line)
      cat "$SCRIPT_DIR/PASTE.txt"
      exit 0
      ;;
    --apply) MODE=apply; shift ;;
    --check-only) MODE=check; shift ;;
    --skip-volume-check) SKIP_VOLUME_CHECK=1; shift ;;
    --keep-mounted) KEEP_MOUNTED=1; shift ;;
    --no-ssh) ENABLE_SSH=0; shift ;;
    --mount)
      [ "$#" -ge 2 ] || { echo "ERROR: --mount needs a path." >&2; exit 2; }
      MOUNT_POINT="$2"
      shift 2
      ;;
    --source)
      [ "$#" -ge 2 ] || { echo "ERROR: --source needs a path." >&2; exit 2; }
      SOURCE_OVERRIDE="$2"
      shift 2
      ;;
    --user)
      [ "$#" -ge 2 ] || { echo "ERROR: --user needs a name." >&2; exit 2; }
      TARGET_USER_OVERRIDE="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1 (use --help)" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- preflight

if [ "$MODE" = "apply" ] && [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this with sudo (the pasted line already does)." >&2
  exit 2
fi

if [ -n "$TARGET_USER_OVERRIDE" ]; then
  TARGET_USER="$TARGET_USER_OVERRIDE"
elif [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
  TARGET_USER="$SUDO_USER"
else
  TARGET_USER="harout"
fi
id "$TARGET_USER" >/dev/null 2>&1 || die "no such user: $TARGET_USER"

if [ "$MODE" = "check" ]; then
  LOG_FILE=""
else
  umask 077
  LOG_FILE="/var/log/hbots-first-login-$(date +%Y%m%d-%H%M%S).log"
  : > "$LOG_FILE"
  chmod 600 "$LOG_FILE"
  # Everything below goes to the screen and to the log. The passphrase prompt
  # goes to stderr but the passphrase itself is read from the terminal and is
  # never written by anything here.
  exec > >(tee -a "$LOG_FILE") 2>&1
fi

printf '\n==> hbots Omarchy first login\n'
info "mode:     $MODE"
info "user:     $TARGET_USER"
info "ssd:      $MOUNT_POINT"
[ -n "$LOG_FILE" ] && info "log:      $LOG_FILE"

# ---------------------------------------------------------------- 1. the SSD

log "1/5 Verify the external SSD"
if [ ! -d "$MOUNT_POINT" ]; then
  die "$MOUNT_POINT does not exist. Run the PASTE-ME.txt line from the SSD instead."
fi
[ -f "$MOUNT_POINT/payload/first-login.sh" ] \
  || die "no payload on $MOUNT_POINT. Is the SanDisk plugged in and mounted?"
[ -f "$MOUNT_POINT/payload/bootstrap.sh" ] \
  || die "the payload is incomplete (bootstrap.sh is missing)."

if [ "$SKIP_VOLUME_CHECK" -eq 1 ]; then
  info "volume identity check skipped (test mode)"
elif mountpoint -q "$MOUNT_POINT"; then
  device="$(findmnt -n -o SOURCE --mountpoint "$MOUNT_POINT" | head -1)"
  [ -n "$device" ] || die "cannot find the device behind $MOUNT_POINT."
  fstype="$(findmnt -n -o FSTYPE --mountpoint "$MOUNT_POINT" | head -1)"
  case "$fstype" in
    ntfs3|ntfs) ;;
    *) die "$MOUNT_POINT is $fstype, not NTFS. Refusing to restore from it." ;;
  esac
  parent="$(lsblk -no PKNAME "$device" 2>/dev/null | head -1)"
  if [ -n "$parent" ]; then disk="/dev/$parent"; else disk="$device"; fi
  model="$(lsblk -dno MODEL "$disk" 2>/dev/null | sed 's/ *$//')"
  serial="$(lsblk -dno SERIAL "$disk" 2>/dev/null | tr -d '[:space:]')"
  info "device:   $device ($fstype)"
  info "model:    ${model:-unknown}"
  info "serial:   ${serial:-unknown}"
  case "$model" in
    *"$EXPECTED_MODEL"*) ;;
    *) die "this is not the $EXPECTED_MODEL drive (model: ${model:-unknown}). Refusing to restore from it." ;;
  esac
  [ "$serial" = "$EXPECTED_SERIAL" ] \
    || die "serial ${serial:-unknown} is not the expected $EXPECTED_SERIAL. Refusing to restore from it."
  options="$(findmnt -n -o OPTIONS --mountpoint "$MOUNT_POINT" | head -1)"
  case ",$options," in
    *,ro,*) info "mounted read-only" ;;
    *)
      info "remounting read-only"
      mount -o remount,ro "$MOUNT_POINT" || die "could not remount $MOUNT_POINT read-only."
      ;;
  esac
else
  die "$MOUNT_POINT is not a mount point. Run the PASTE-ME.txt line from the SSD."
fi

# ---------------------------------------------------------------- 2. payload

log "2/5 Verify the payload"
[ -f "$MOUNT_POINT/payload.sha256" ] || die "payload.sha256 is missing; the copy is incomplete."
if ! ( cd "$MOUNT_POINT" && sha256sum --quiet -c payload.sha256 ); then
  die "payload hash check failed. The SSD copy is damaged; do not restore from it."
fi
FILES_COUNT="$(wc -l < "$MOUNT_POINT/payload.sha256" | tr -d ' ')"
info "$FILES_COUNT payload files match their hashes"

RESTORE_SOURCE="${SOURCE_OVERRIDE:-$MOUNT_POINT/plain}"
[ -d "$RESTORE_SOURCE/Claude" ] || die "restore copy is missing $RESTORE_SOURCE/Claude"
[ -d "$RESTORE_SOURCE/personal-bots" ] || die "restore copy is missing $RESTORE_SOURCE/personal-bots"

BUNDLE="$MOUNT_POINT/secrets.bundle"
HAS_BUNDLE=0
if [ -f "$BUNDLE" ]; then
  HAS_BUNDLE=1
  info "secrets bundle: present (contents are never printed)"
  BUNDLE_BYTES="$(stat -c %s "$BUNDLE")"
  info "secrets bundle: $BUNDLE_BYTES bytes"
  SECRETS_ARGS=(--secrets-bundle "$BUNDLE")
else
  SECRETS_ARGS=(--skip-secrets)
fi

if [ "$MODE" = "check" ]; then
  log "Check complete"
  info "the SSD and payload are good; nothing was changed"
  exit 0
fi

# ---------------------------------------------------------------- 3. work copy

log "3/5 Stage the scripts off the read-only SSD"
WORK_DIR="$(mktemp -d /var/tmp/hbots-migrate.XXXXXX)"
chmod 700 "$WORK_DIR"
cp -a "$MOUNT_POINT/payload/." "$WORK_DIR/"
info "scripts: $WORK_DIR"

# ---------------------------------------------------------------- 4. ssh

log "4/5 SSH access for the team"
if [ "$ENABLE_SSH" -eq 1 ]; then
  if bash "$WORK_DIR/enable-ssh.sh" --apply; then
    info "sshd is up and the team's public keys are installed"
  else
    info "WARNING: sshd setup failed; the restore can still finish locally"
  fi
else
  info "skipped (--no-ssh)"
fi

# ---------------------------------------------------------------- 5. restore

log "5/5 Restore and install (bootstrap + verify)"
BOOTSTRAP_ARGS=(--apply --source "$RESTORE_SOURCE" --user "$TARGET_USER")
BOOTSTRAP_ARGS+=("${SECRETS_ARGS[@]}")

if [ "$HAS_BUNDLE" -eq 0 ]; then
  printf '\n    WARNING: no secrets.bundle on the SSD. Bots will start without their saved keys.\n' >&2
  printf '    The restore still runs; the bundle can be imported later.\n\n' >&2
fi

set +e
bash "$WORK_DIR/bootstrap.sh" "${BOOTSTRAP_ARGS[@]}"
BOOTSTRAP_STATUS=$?
set -e

if [ "$BOOTSTRAP_STATUS" -ne 0 ]; then
  write_status failed "bootstrap exited $BOOTSTRAP_STATUS"
  printf '\n' >&2
  printf 'FAILED: the restore stopped with exit %s. The SSD is still mounted at %s.\n' \
    "$BOOTSTRAP_STATUS" "$MOUNT_POINT" >&2
  printf 'Log: %s\n' "$LOG_FILE" >&2
  printf 'Send that log to the team; do not wipe or reinstall anything.\n' >&2
  exit "$BOOTSTRAP_STATUS"
fi

write_status ok "bootstrap and verify finished"

printf '\n'
printf '============================================================\n'
printf ' SUCCESS: Omarchy is restored and hbots is running.\n'
printf ' Log: %s\n' "$LOG_FILE"
printf '============================================================\n'

if [ "$HAS_BUNDLE" -eq 0 ]; then
  printf '\n SECRETS MISSING: bots are up but have no saved keys.\n'
  printf ' Import secrets.bundle before using them.\n'
fi

if [ "$KEEP_MOUNTED" -eq 0 ]; then
  sync || true
  if umount "$MOUNT_POINT" 2>/dev/null; then
    printf '\n The SanDisk is unmounted. You can unplug it.\n'
  else
    printf '\n The SanDisk is still mounted; unplug it when ready.\n'
  fi
fi
printf '\n'
exit 0
