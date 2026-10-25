#!/usr/bin/env bash
#
# bootstrap.sh - bring a fresh Omarchy install up to the hbots baseline.
#
# Run over SSH as root on the new machine, after Harout pasted the one-liner
# from enable-ssh.sh on its first login. Both modes are explicit:
#
#   ./bootstrap.sh --dry-run --source /mnt/gamingpc/omarchy-migration/plain
#   ./bootstrap.sh --apply   --source /mnt/gamingpc/omarchy-migration/plain
#
# --dry-run prints every step and changes nothing. --apply does the work.
# There is no implicit apply.
#
# Steps, in order:
#   0. check SSH access (the team reaches this machine over SSH; if sshd is
#      down, print the enable-ssh.sh one-liner and carry on)
#   1. verify this is Omarchy on Arch
#   2. restore Claude/ and personal-bots/ from the gaming PC
#   3. install packages: base-devel, git, python, nodejs + mise node 24.22.1,
#      pnpm 11.10.0 via corepack, brave-bin (AUR), cloudflared, lm_sensors,
#      ollama
#   4. install the systemd user units, with T3CODE_PATH_MAP set in the hbots
#      unit so migration 113 rewrites stored Windows paths on the first boot
#   5. import the sealed secrets bundle with `bin.mjs secrets import`
#   6. start hbots and wait for its health endpoint
#   7. open 38472 (hbots), 5186 (Kino), 8765 (docs) on the active firewall
#   8. keep updates manual and print the snapshot-before-update guidance
#   9. run verify.sh
#
# Nothing is deleted. rsync runs without --delete. Secret values are never
# printed or passed as arguments: the importer reads the passphrase from
# HBOTS_SECRETS_PASSPHRASE or from one line on stdin.
#
# Defaults:
#   --source /mnt/gamingpc/omarchy-migration/plain
#   --repo   <target home>/Claude/AI/personal-bots
#   --data-dir <target home>/.personal-bots
#   --user   $SUDO_USER, else harout
#
# The restore source must contain Claude/ and personal-bots/, which is the
# layout prewipe.ps1 writes under <target>/plain. Mount the SMB share or use an
# rsync-over-SSH source such as harout@gamingpc:/srv/omarchy-restore/plain/.
#
set -euo pipefail

APPLY=0
DRY_RUN=0
SOURCE_ARG=""
REPO_ARG=""
DATA_ARG=""
USER_ARG=""
SECRETS_ARG=""
SKIP_RESTORE=0
SKIP_PACKAGES=0
SKIP_SECRETS=0
SKIP_START=0
SKIP_VERIFY=0

usage() {
  sed -n '2,55p' "$0" | sed 's/^# \{0,1\}//'
}

log() {
  printf '\n==> %s\n' "$*"
}

info() {
  printf '    %s\n' "$*"
}

warn() {
  printf '    WARNING: %s\n' "$*" >&2
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    +'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

run_as_user() {
  local uid
  uid="$(id -u "$TARGET_USER" 2>/dev/null || true)"
  local -a envs=("HOME=$TARGET_HOME" "USER=$TARGET_USER" "LOGNAME=$TARGET_USER")
  if [ -n "$uid" ]; then
    envs+=("XDG_RUNTIME_DIR=/run/user/$uid")
  fi
  if [ "$(id -u)" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
    if command -v runuser >/dev/null 2>&1; then
      run runuser -u "$TARGET_USER" -- env "${envs[@]}" "$@"
    else
      die "runuser is missing; install util-linux."
    fi
  else
    run env "${envs[@]}" "$@"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)
      APPLY=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --source)
      [ "$#" -ge 2 ] || die "--source needs a value."
      SOURCE_ARG="$2"
      shift 2
      ;;
    --repo)
      [ "$#" -ge 2 ] || die "--repo needs a value."
      REPO_ARG="$2"
      shift 2
      ;;
    --data-dir)
      [ "$#" -ge 2 ] || die "--data-dir needs a value."
      DATA_ARG="$2"
      shift 2
      ;;
    --user)
      [ "$#" -ge 2 ] || die "--user needs a value."
      USER_ARG="$2"
      shift 2
      ;;
    --secrets-bundle)
      [ "$#" -ge 2 ] || die "--secrets-bundle needs a value."
      SECRETS_ARG="$2"
      shift 2
      ;;
    --skip-restore)
      SKIP_RESTORE=1
      shift
      ;;
    --skip-packages)
      SKIP_PACKAGES=1
      shift
      ;;
    --skip-secrets)
      SKIP_SECRETS=1
      shift
      ;;
    --skip-start)
      SKIP_START=1
      shift
      ;;
    --skip-verify)
      SKIP_VERIFY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1 (use --help)"
      ;;
  esac
done

if [ "$APPLY" -eq 1 ] && [ "$DRY_RUN" -eq 1 ]; then
  die "--apply and --dry-run cannot be combined."
fi
if [ "$APPLY" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  die "choose --dry-run or --apply; there is no implicit apply."
fi

if [ -n "$USER_ARG" ]; then
  TARGET_USER="$USER_ARG"
elif [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
  TARGET_USER="$SUDO_USER"
else
  TARGET_USER="harout"
fi

if [ "$(id -u)" -eq 0 ] && [ "$TARGET_USER" = "root" ]; then
  TARGET_USER="harout"
fi

TARGET_HOME="$(getent passwd "$TARGET_USER" 2>/dev/null | cut -d: -f6 || true)"
if [ -z "$TARGET_HOME" ]; then
  TARGET_HOME="/home/$TARGET_USER"
fi
TARGET_GROUP="$(id -gn "$TARGET_USER" 2>/dev/null || printf '%s' "$TARGET_USER")"

SOURCE="${SOURCE_ARG:-/mnt/gamingpc/omarchy-migration/plain}"
REPO="${REPO_ARG:-$TARGET_HOME/Claude/AI/personal-bots}"
DATA_DIR="${DATA_ARG:-$TARGET_HOME/.personal-bots}"
SECRETS_BUNDLE="${SECRETS_ARG:-$TARGET_HOME/omarchy-secrets.bundle}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RELEASES_DIR="$DATA_DIR/releases"
CURRENT_FILE="$RELEASES_DIR/current.txt"
SECRETS_DIR="$DATA_DIR/dev/userdata/secrets"
PATH_MAP="C:/Users/Ht=$TARGET_HOME;C:/Claude/AI=$TARGET_HOME/Claude/AI"

log "hbots Omarchy bootstrap"
info "mode:       $([ "$APPLY" -eq 1 ] && echo APPLY || echo DRY-RUN)"
info "user:       $TARGET_USER ($TARGET_HOME)"
info "repo:       $REPO"
info "data:       $DATA_DIR"
info "restore:    $SOURCE"
info "secrets:    $SECRETS_BUNDLE"
info "path map:   $PATH_MAP"

if [ "$APPLY" -eq 1 ]; then
  [ "$(id -u)" -eq 0 ] || die "--apply must run as root (over SSH)."
fi

# ---------------------------------------------------------------- 0. SSH access

log "0/9 SSH access"
SSH_ENABLE_LINE="bash $SCRIPT_DIR/enable-ssh.sh --apply"
if [ "$DRY_RUN" -eq 1 ]; then
  info "would check sshd is active"
  info "if not, the first-login one-liner is printed by: bash $SCRIPT_DIR/enable-ssh.sh"
elif systemctl is-active --quiet sshd 2>/dev/null; then
  info "sshd is active"
else
  warn "sshd is not active on this machine."
  warn "Harout can paste this once at the laptop console: $SSH_ENABLE_LINE"
  warn "or run: bash $SCRIPT_DIR/enable-ssh.sh --apply"
fi

# ---------------------------------------------------------------- 1. OS check

log "1/9 Verify Omarchy on Arch"
if [ "$DRY_RUN" -eq 1 ]; then
  info "would require /etc/os-release ID=arch and an omarchy command or /usr/share/omarchy"
else
  [ -r /etc/os-release ] || die "/etc/os-release is missing; this is not Arch."
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-} ${ID_LIKE:-}" in
    *arch*) ;;
    *) die "this is not Arch (ID=${ID:-?}, ID_LIKE=${ID_LIKE:-?})."
      ;;
  esac
  if ! command -v omarchy >/dev/null 2>&1 && [ ! -d /usr/share/omarchy ]; then
    die "Omarchy is not installed (no omarchy command and no /usr/share/omarchy)."
  fi
  info "Omarchy/Arch detected"
fi

# ---------------------------------------------------------------- 2. restore

log "2/9 Restore data from the gaming PC"
if [ "$SKIP_RESTORE" -eq 1 ]; then
  warn "restore skipped (--skip-restore)"
else
  if ! command -v rsync >/dev/null 2>&1; then
    if [ "$DRY_RUN" -eq 1 ]; then
      info "rsync is missing; apply would install it first"
    else
      info "installing rsync"
      run pacman -S --needed --noconfirm rsync
    fi
  fi

  if [ ! -d "$SOURCE" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      warn "source not mounted: $SOURCE"
    else
      die "restore source is not available: $SOURCE. Mount the gaming PC share and pass --source."
    fi
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    info "would check $SOURCE/Claude and $SOURCE/personal-bots"
    run install -d -o "$TARGET_USER" -g "$TARGET_GROUP" "$TARGET_HOME/Claude"
    run install -d -o "$TARGET_USER" -g "$TARGET_GROUP" "$DATA_DIR"
    run_as_user rsync -aH --info=progress2 "--chown=$TARGET_USER:$TARGET_GROUP" "$SOURCE/Claude/" "$TARGET_HOME/Claude/"
    run_as_user rsync -aH --info=progress2 "--chown=$TARGET_USER:$TARGET_GROUP" "$SOURCE/personal-bots/" "$DATA_DIR/"
  else
    [ -d "$SOURCE/Claude" ] || die "missing $SOURCE/Claude. The prewipe plain copy has Claude/ and personal-bots/."
    [ -d "$SOURCE/personal-bots" ] || die "missing $SOURCE/personal-bots. The prewipe plain copy has Claude/ and personal-bots/."
    install -d -o "$TARGET_USER" -g "$TARGET_GROUP" "$TARGET_HOME/Claude"
    install -d -o "$TARGET_USER" -g "$TARGET_GROUP" "$DATA_DIR"
    run_as_user rsync -aH --info=progress2 "--chown=$TARGET_USER:$TARGET_GROUP" "$SOURCE/Claude/" "$TARGET_HOME/Claude/"
    run_as_user rsync -aH --info=progress2 "--chown=$TARGET_USER:$TARGET_GROUP" "$SOURCE/personal-bots/" "$DATA_DIR/"
    info "restore complete (no files were deleted)"
  fi
fi

# ---------------------------------------------------------------- 3. packages

log "3/9 Install packages"
if [ "$SKIP_PACKAGES" -eq 1 ]; then
  warn "packages skipped (--skip-packages)"
else
  # A fresh Omarchy ISO only carries the ISO's package database, and the mise
  # package is named mise-bin. brave-bin is in Omarchy's repo; AUR only when not.
  run pacman -Sy --noconfirm
  run pacman -S --needed --noconfirm base-devel git python nodejs mise-bin rsync cloudflared lm_sensors ollama

  info "mise node 24.22.1"
  run_as_user mise install node@24.22.1
  run_as_user mise use -g node@24.22.1

  info "pnpm 11.10.0 via corepack"
  if command -v corepack >/dev/null 2>&1; then
    run_as_user corepack enable
    run_as_user corepack prepare pnpm@11.10.0 --activate
  else
    run_as_user mise exec node@24.22.1 -- corepack enable
    run_as_user mise exec node@24.22.1 -- corepack prepare pnpm@11.10.0 --activate
  fi

  info "brave-bin"
  if pacman -Qq brave-bin >/dev/null 2>&1; then
    info "brave-bin already installed"
  elif [ "$DRY_RUN" -eq 1 ]; then
    info "would install brave-bin from the Omarchy repo (yay only as a fallback)"
  elif pacman -Ssq '^brave-bin$' | grep -q .; then
    run pacman -S --needed --noconfirm brave-bin
  elif command -v yay >/dev/null 2>&1; then
    if ! run_as_user yay -S --needed --noconfirm brave-bin; then
      warn "brave-bin install failed; install it manually with: yay -S brave-bin"
    fi
  elif command -v paru >/dev/null 2>&1; then
    if ! run_as_user paru -S --needed --noconfirm brave-bin; then
      warn "brave-bin install failed; install it manually with: paru -S brave-bin"
    fi
  else
    warn "no AUR helper (yay/paru) found; install brave-bin manually: yay -S brave-bin"
  fi
fi

# ---------------------------------------------------------------- 4. units

log "4/9 Install systemd user units"
UNIT_INSTALL="$REPO/scripts/personal/linux/install-units.sh"
if [ -f "$UNIT_INSTALL" ]; then
  info "installer: $UNIT_INSTALL"
  info "T3CODE_PATH_MAP goes into hbots.service before its first start"
  run_as_user bash "$UNIT_INSTALL" --repo "$REPO" --ai-dir "$TARGET_HOME/Claude/AI" --node "$TARGET_HOME/.local/share/mise/installs/node/24.22.1/bin/node" --path-map "$PATH_MAP"
  run loginctl enable-linger "$TARGET_USER"
  if [ "$DRY_RUN" -eq 0 ]; then
    installed_unit="$TARGET_HOME/.config/systemd/user/hbots.service"
    [ -f "$installed_unit" ] || die "hbots.service was not written to $installed_unit."
    grep -qF "T3CODE_PATH_MAP=$PATH_MAP" "$installed_unit" \
      || die "T3CODE_PATH_MAP is missing from $installed_unit; the first boot would not rewrite Windows paths."
    info "path map present in hbots.service"
  fi
else
  warn "no unit installer at $UNIT_INSTALL. User units were not installed."
  info "expected scripts/personal/linux/install-units.sh from the ops branch"
fi

# ---------------------------------------------------------------- 5. secrets

log "5/9 Import sealed secrets"
RELEASE_BIN=""
if [ -r "$CURRENT_FILE" ]; then
  current_name="$(tr -d '[:space:]' < "$CURRENT_FILE")"
  if [ -n "$current_name" ] && [ -f "$RELEASES_DIR/$current_name/bin.mjs" ]; then
    RELEASE_BIN="$RELEASES_DIR/$current_name/bin.mjs"
  fi
fi
if [ -z "$RELEASE_BIN" ] && [ -d "$RELEASES_DIR" ]; then
  RELEASE_BIN="$(find "$RELEASES_DIR" -mindepth 2 -maxdepth 2 -name bin.mjs -type f -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2- || true)"
fi

if [ "$SKIP_SECRETS" -eq 1 ]; then
  warn "secrets import skipped (--skip-secrets)"
elif [ -z "$RELEASE_BIN" ]; then
  warn "no release bin.mjs found under $RELEASES_DIR; secrets were not imported."
  info "build or restore a release, then run: node <release>/bin.mjs secrets import ..."
elif [ ! -f "$SECRETS_BUNDLE" ]; then
  warn "secrets bundle not found at $SECRETS_BUNDLE; pass --secrets-bundle. Import skipped."
  info "Harout can run the import himself after copying the bundle to this machine."
else
  info "release: $RELEASE_BIN"
  info "bundle:  $SECRETS_BUNDLE (contents are never printed)"
  info "target:  $SECRETS_DIR"
  import_args=(secrets import --secrets-dir "$SECRETS_DIR" --in "$SECRETS_BUNDLE")
  if [ "$DRY_RUN" -eq 1 ]; then
    info "would run: node $RELEASE_BIN ${import_args[*]}"
    info "passphrase: HBOTS_SECRETS_PASSPHRASE or one line on stdin"
  elif [ -n "${HBOTS_SECRETS_PASSPHRASE:-}" ]; then
    run_as_user node "$RELEASE_BIN" "${import_args[@]}"
    info "secrets imported"
  elif [ -t 0 ]; then
    printf '    Secrets passphrase (not echoed): ' >&2
    IFS= read -rs SECRETS_PASSPHRASE
    printf '\n' >&2
    [ -n "$SECRETS_PASSPHRASE" ] || die "empty passphrase; nothing imported."
    if [ "$(id -u)" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
      run printf '%s\n' "$SECRETS_PASSPHRASE" | runuser -u "$TARGET_USER" -- env "HOME=$TARGET_HOME" "USER=$TARGET_USER" "LOGNAME=$TARGET_USER" "XDG_RUNTIME_DIR=/run/user/$(id -u "$TARGET_USER")" node "$RELEASE_BIN" "${import_args[@]}"
    else
      printf '%s\n' "$SECRETS_PASSPHRASE" | env "HOME=$TARGET_HOME" node "$RELEASE_BIN" "${import_args[@]}"
    fi
    unset SECRETS_PASSPHRASE
    info "secrets imported"
  else
    warn "no passphrase available in this non-interactive session; secrets were not imported."
    info "Harout runs this himself at the laptop terminal:"
    info "  HBOTS_SECRETS_PASSPHRASE='<his passphrase>' node $RELEASE_BIN ${import_args[*]}"
  fi
fi

# ---------------------------------------------------------------- 6. start

log "6/9 Start hbots"
if [ "$SKIP_START" -eq 1 ]; then
  warn "start skipped (--skip-start)"
elif [ "$DRY_RUN" -eq 1 ]; then
  info "would start hbots.service and wait for http://127.0.0.1:38472/.well-known/t3/environment"
  info "would fail if the log shows 'T3CODE_PATH_MAP is not set; no stored paths rewritten.'"
else
  run_as_user systemctl --user start hbots.service
  healthy=0
  for _ in $(seq 1 45); do
    if curl -fsS --max-time 3 http://127.0.0.1:38472/.well-known/t3/environment >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 2
  done
  if [ "$healthy" -ne 1 ]; then
    warn "hbots did not answer on 38472 within 90 s."
    run_as_user journalctl --user -u hbots.service -b --no-pager -n 40 || true
    die "hbots failed to start; fix the log above before continuing."
  fi
  info "hbots is answering on 38472"
  if run_as_user journalctl --user -u hbots.service -b --no-pager 2>/dev/null | grep -q 'T3CODE_PATH_MAP is not set'; then
    die "hbots booted without T3CODE_PATH_MAP. Restore the DB copy (prewipe copy is unmodified) and start again with the map set; migration 113 will not run twice."
  fi
  info "path map was present on the first boot"
fi

# ---------------------------------------------------------------- 7. firewall

log "7/9 Open firewall ports (38472 hbots, 5186 Kino, 8765 docs)"
PORTS=(38472 5186 8765)

if [ "$DRY_RUN" -eq 1 ]; then
  info "would detect the active firewall and open only these TCP ports: ${PORTS[*]}"
  info "ufw example: ufw allow 38472/tcp comment hbots"
  info "firewalld example: firewall-cmd --permanent --add-port=38472/tcp && firewall-cmd --reload"
  info "nftables example: a dedicated inet hbots table plus hbots-firewall.service"
else
  opened=0
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
    info "ufw is active"
    for port in "${PORTS[@]}"; do
      if ufw status 2>/dev/null | grep -qE "^${port}/tcp[[:space:]]+ALLOW"; then
        info "ufw already allows $port/tcp"
      else
        run ufw allow "$port/tcp" comment 'hbots'
      fi
    done
    opened=1
  fi

  if systemctl is-active --quiet firewalld 2>/dev/null; then
    info "firewalld is active"
    for port in "${PORTS[@]}"; do
      if firewall-cmd --query-port="$port/tcp" >/dev/null 2>&1; then
        info "firewalld already allows $port/tcp"
      else
        run firewall-cmd --permanent --add-port="$port/tcp"
      fi
    done
    run firewall-cmd --reload
    opened=1
  fi

  if [ "$opened" -eq 0 ] && systemctl is-active --quiet nftables 2>/dev/null; then
    info "nftables is active; adding a dedicated inet hbots table"
    if ! nft list table inet hbots >/dev/null 2>&1; then
      run nft add table inet hbots
    fi
    if ! nft list chain inet hbots input >/dev/null 2>&1; then
      run nft 'add chain inet hbots input { type filter hook input priority 0; policy accept; }'
    fi
    for port in "${PORTS[@]}"; do
      if nft list chain inet hbots input 2>/dev/null | grep -q "dport $port"; then
        info "nftables already allows $port/tcp"
      else
        run nft add rule inet hbots input tcp dport "$port" ct state new accept
      fi
    done

    info "persisting with hbots-firewall.service"
    cat > /usr/local/bin/hbots-firewall <<'EOF'
#!/usr/bin/env bash
set -u
nft list table inet hbots >/dev/null 2>&1 || nft add table inet hbots
nft list chain inet hbots input >/dev/null 2>&1 || nft 'add chain inet hbots input { type filter hook input priority 0; policy accept; }'
for p in 38472 5186 8765; do
  nft list chain inet hbots input 2>/dev/null | grep -q "dport $p" || nft add rule inet hbots input tcp dport "$p" ct state new accept
done
EOF
    chmod 0755 /usr/local/bin/hbots-firewall
    cat > /etc/systemd/system/hbots-firewall.service <<'EOF'
[Unit]
Description=Open hbots, Kino and docs ports in nftables
After=nftables.service network-pre.target
Wants=nftables.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/hbots-firewall

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now hbots-firewall.service
    opened=1
  fi

  if [ "$opened" -eq 0 ]; then
    info "no active ufw, firewalld or nftables firewall detected; nothing was opened."
  fi
fi

# ---------------------------------------------------------------- 8. updates

log "8/9 Update policy"
if [ "$DRY_RUN" -eq 1 ]; then
  info "would disable pacman-auto-update.timer and unattended-upgrades.service if enabled"
else
  for unit in pacman-auto-update.timer unattended-upgrades.service; do
    if systemctl is-enabled --quiet "$unit" 2>/dev/null; then
      info "disabling $unit (updates stay manual)"
      run systemctl disable --now "$unit"
    fi
  done
fi
info "Updates are manual. Unattended upgrades are intentionally not enabled."
info "Before an update: sudo snapper -c root create --description pre-update"
info "If snapper is unavailable: omarchy-snapshot create (or the Omarchy menu snapshot entry)."
info "Then run: omarchy-update"

# ---------------------------------------------------------------- 9. verify

log "9/9 Verify"
if [ "$SKIP_VERIFY" -eq 1 ]; then
  warn "verify skipped (--skip-verify)"
else
  [ -f "$SCRIPT_DIR/verify.sh" ] || die "verify.sh is missing next to bootstrap.sh."
  run bash "$SCRIPT_DIR/verify.sh" --user "$TARGET_USER" --repo "$REPO"
fi

log "Done"
info "hbots user: $TARGET_USER"
info "Data:       $DATA_DIR"
info "Repo:       $REPO"
info "If verify reported failures, fix those before handing the laptop to Harout."
