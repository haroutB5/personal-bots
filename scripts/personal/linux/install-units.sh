#!/usr/bin/env bash
# Install the hbots user units for this machine. Renders the .in templates with
# absolute paths, writes them to ~/.config/systemd/user, then daemon-reloads and
# enables the core set. Nothing here needs root.
#
# Usage:
#   bash scripts/personal/linux/install-units.sh [--dry-run]
#        [--repo DIR] [--ai-dir DIR] [--node PATH] [--python PATH] [--no-enable]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_DIR="$HERE/systemd"
DRY_RUN=0
ENABLE=1
REPO="${HBOTS_REPO:-$(cd "$HERE/../../.." && pwd)}"
AI_DIR="${HBOTS_AI_DIR:-$HOME/AI}"
NODE_BIN="${HBOTS_NODE:-$(command -v node || true)}"
PYTHON_BIN="${HBOTS_PYTHON:-$(command -v python3 || true)}"
HOME_DIR="$HOME"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --no-enable) ENABLE=0; shift ;;
    --repo) REPO="$2"; shift 2 ;;
    --ai-dir) AI_DIR="$2"; shift 2 ;;
    --node) NODE_BIN="$2"; shift 2 ;;
    --python) PYTHON_BIN="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "node not found; pass --node <path> or set HBOTS_NODE" >&2
  exit 1
fi
if [ -z "$PYTHON_BIN" ]; then PYTHON_BIN=/usr/bin/python3; fi

TARGET="$HOME/.config/systemd/user"
CORE_UNITS=(
  hbots.service
  hbots-upstream-sync.timer
  hbots-nightly-updates.timer
  tennis-poll.timer
  tennis-book.timer
  matchday-sofascore-fetcher.service
  docs-server.service
)
OPTIONAL_UNITS=(urgot.service cloudflared.service)

render() {
  sed -e "s|@REPO@|$REPO|g" \
      -e "s|@AI@|$AI_DIR|g" \
      -e "s|@NODE@|$NODE_BIN|g" \
      -e "s|@PYTHON@|$PYTHON_BIN|g" \
      -e "s|@HOME@|$HOME_DIR|g" "$1"
}

echo "repo   $REPO"
echo "ai     $AI_DIR"
echo "node   $NODE_BIN"
echo "python $PYTHON_BIN"
echo "target $TARGET"
[ "$DRY_RUN" = 1 ] && echo "DRY RUN: nothing is written, reloaded or enabled"

for template in "$SYSTEMD_DIR"/*.in; do
  unit="$(basename "$template" .in)"
  rendered="$(render "$template")"
  if [ "$DRY_RUN" = 1 ]; then
    echo "would write $TARGET/$unit"
  else
    mkdir -p "$TARGET"
    printf '%s\n' "$rendered" > "$TARGET/$unit"
    echo "wrote $TARGET/$unit"
  fi
done
# Timers are not templates; copy them unchanged.
for timer in "$SYSTEMD_DIR"/*.timer; do
  unit="$(basename "$timer")"
  if [ "$DRY_RUN" = 1 ]; then
    echo "would write $TARGET/$unit"
  else
    mkdir -p "$TARGET"
    cp "$timer" "$TARGET/$unit"
    echo "wrote $TARGET/$unit"
  fi
done

if [ "$DRY_RUN" = 1 ]; then
  echo "would run: systemctl --user daemon-reload"
  [ "$ENABLE" = 1 ] && echo "would enable: ${CORE_UNITS[*]}"
  exit 0
fi

systemctl --user daemon-reload
if [ "$ENABLE" = 1 ]; then
  systemctl --user enable "${CORE_UNITS[@]}"
  echo "Enabled: ${CORE_UNITS[*]}"
  echo "Left disabled on purpose: ${OPTIONAL_UNITS[*]}"
  echo "Start now with: systemctl --user start hbots.service"
fi
