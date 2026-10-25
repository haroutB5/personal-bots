#!/usr/bin/env bash
#
# bootstrap.sh - bring a fresh Omarchy install up to the hbots baseline.
#
# Run over SSH as root on the new machine. Both modes are explicit:
#
#   ./bootstrap.sh --dry-run --source /mnt/gamingpc/omarchy-migration/plain
#   ./bootstrap.sh --apply   --source /mnt/gamingpc/omarchy-migration/plain
#
# --dry-run prints every step and changes nothing. --apply does the work.
# There is no implicit apply.
#
# Steps, in order:
#   1. verify this is Omarchy on Arch
#   2. restore C:\Claude and C:\Users\Ht\.personal-bots from the gaming PC
#   3. rewrite stored Windows paths with Backend's migrate-paths.mjs
#   4. import the sealed secrets bundle, if Backend's importer is present
#   5. install packages: base-devel, git, python, nodejs + mise node 24.22.1,
#      pnpm 11.10.0 via corepack, brave-bin (AUR), cloudflared, lm_sensors,
#      ollama
#   6. install the systemd user units, if their install script is present
#   7. open 38472 (hbots), 5186 (Kino), 8765 (docs) on the active firewall
#   8. keep updates manual and print the snapshot-before-update guidance
#   9. run verify.sh
#
# Nothing is deleted. rsync runs without --delete. Secret values are never
# printed: the importer prompts on the terminal and only its status is logged.
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
SKIP_VERIFY=0

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
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

log "hbots Omarchy bootstrap"
info "mode:       $([ "$APPLY" -eq 1 ] && echo APPLY || echo DRY-RUN)"
info "user:       $TARGET_USER ($TARGET_HOME)"
info "repo:       $REPO"
info "data:       $DATA_DIR"
info "restore:    $SOURCE"
info "secrets:    $SECRETS_BUNDLE"

if [ "$APPLY" -eq 1 ]; then
  [ "$(id -u)" -eq 0 ] || die "--apply must run as root (over SSH)."
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

# ---------------------------------------------------------------- 3. paths

log "3/9 Rewrite stored Windows paths"
if [ "$SKIP_RESTORE" -eq 1 ]; then
  # No restored Windows data means there is nothing to rewrite. This keeps a
  # base-host or VM proof from stopping on Backend's migrator being absent.
  info "path rewrite skipped (--skip-restore: no Windows data was restored)"
else
MIGRATE_PATHS="$REPO/scripts/personal/node/migrate-paths.mjs"
if [ ! -f "$MIGRATE_PATHS" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    warn "MISSING $MIGRATE_PATHS (apply would stop here)"
    info "expected interface: node migrate-paths.mjs --data-dir <dir> --repo <dir> --apply"
  else
    die "Backend's path migration is missing: $MIGRATE_PATHS. Expected: node migrate-paths.mjs --data-dir <dir> --repo <dir> --apply. Nothing after this step ran."
  fi
else
  if command -v node >/dev/null 2>&1; then
    run_as_user node "$MIGRATE_PATHS" --data-dir "$DATA_DIR" --repo "$REPO" --apply
  elif command -v mise >/dev/null 2>&1; then
    run_as_user mise exec node@24.22.1 -- node "$MIGRATE_PATHS" --data-dir "$DATA_DIR" --repo "$REPO" --apply
  else
    if [ "$DRY_RUN" -eq 1 ]; then
      warn "neither node nor mise is available yet; apply would stop here"
    else
      die "node is not installed and mise is missing. Install node or mise, then rerun (packages come after this step by design)."
    fi
  fi
fi
fi

# ---------------------------------------------------------------- 4. secrets

log "4/9 Import sealed secrets"
IMPORTER=""
for candidate in \
  "$REPO/scripts/personal/node/secrets-import.mjs" \
  "$REPO/scripts/personal/node/import-secrets.mjs" \
  "$REPO/migrate/linux/import-secrets.sh"
do
  if [ -f "$candidate" ]; then
    IMPORTER="$candidate"
    break
  fi
done

if [ -z "$IMPORTER" ]; then
  warn "no secrets importer found. The sealed bundle was not imported; logins will need re-approval."
  info "looked for scripts/personal/node/secrets-import.mjs, import-secrets.mjs and migrate/linux/import-secrets.sh"
else
  if [ ! -f "$SECRETS_BUNDLE" ]; then
    warn "secrets bundle not found at $SECRETS_BUNDLE; pass --secrets-bundle. Import skipped."
  else
    info "importer: $IMPORTER"
    info "bundle:   $SECRETS_BUNDLE (contents are never printed)"
    case "$IMPORTER" in
      *.mjs)
        if command -v node >/dev/null 2>&1; then
          run_as_user node "$IMPORTER" --bundle "$SECRETS_BUNDLE" --data-dir "$DATA_DIR"
        else
          run_as_user mise exec node@24.22.1 -- node "$IMPORTER" --bundle "$SECRETS_BUNDLE" --data-dir "$DATA_DIR"
        fi
        ;;
      *.sh)
        run_as_user bash "$IMPORTER" "$SECRETS_BUNDLE"
        ;;
    esac
  fi
fi

# ---------------------------------------------------------------- 5. packages

log "5/9 Install packages"
if [ "$SKIP_PACKAGES" -eq 1 ]; then
  warn "packages skipped (--skip-packages)"
else
  run pacman -S --needed --noconfirm base-devel git python nodejs mise rsync cloudflared lm_sensors ollama

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

  info "brave-bin from the AUR"
  if command -v pacman >/dev/null 2>&1 && pacman -Qq brave-bin >/dev/null 2>&1; then
    info "brave-bin already installed"
  elif [ "$DRY_RUN" -eq 1 ]; then
    info "would use yay or paru as $TARGET_USER: yay -S --needed --noconfirm brave-bin"
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

# ---------------------------------------------------------------- 6. units

log "6/9 Install systemd user units"
UNIT_DIR="$REPO/scripts/personal/linux/systemd"
UNIT_INSTALL="$UNIT_DIR/install-units.sh"
if [ -f "$UNIT_INSTALL" ]; then
  info "installer: $UNIT_INSTALL"
  run_as_user bash "$UNIT_INSTALL"
  run loginctl enable-linger "$TARGET_USER"
else
  warn "no unit installer at $UNIT_INSTALL. User units were not installed."
  info "expected scripts/personal/linux/systemd/install-units.sh from the ops branch"
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
  run bash "$SCRIPT_DIR/verify.sh" --user "$TARGET_USER"
fi

log "Done"
info "hbots user: $TARGET_USER"
info "Data:       $DATA_DIR"
info "Repo:       $REPO"
info "If verify reported failures, fix those before handing the laptop to Harout."
