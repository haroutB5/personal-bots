#!/usr/bin/env bash
# Install the hbots user units for this machine. Renders the .in templates with
# absolute paths, writes them to ~/.config/systemd/user, then daemon-reloads and
# enables the core set. Nothing here needs root.
#
# Usage:
#   bash scripts/personal/linux/install-units.sh [--dry-run]
#        [--repo DIR] [--ai-dir DIR] [--node PATH] [--python PATH]
#        [--path-map "C:/Users/Ht=/home/harout;C:/Claude/AI=/home/harout/claude"]
#        [--no-enable]
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
# OpenCode 2's ~/.local/bin/opencode wrapper runs `mise use -g`, which rewrites
# ~/.config/mise/config.toml; under the isolated XDG dirs hbots gives the agent
# mise then has no trust record and the session dies. Prefer the real installed
# binary on PATH so a fresh install never resolves to that wrapper.
OPENCODE_BIN_DIR=""
for candidate in \
  "$HOME/.local/share/mise/installs/opencode/latest/node_modules/.bin" \
  "$HOME/.local/share/mise/installs/opencode/current/node_modules/.bin"; do
  if [ -x "$candidate/opencode" ]; then OPENCODE_BIN_DIR="$candidate:"; break; fi
done
PATH_MAP="${HBOTS_PATH_MAP:-C:/Users/Ht=$HOME;C:/Claude/AI=$AI_DIR}"
PATH_MAP_EXPLICIT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --no-enable) ENABLE=0; shift ;;
    --repo) REPO="$2"; shift 2 ;;
    --ai-dir) AI_DIR="$2"; shift 2 ;;
    --node) NODE_BIN="$2"; shift 2 ;;
    --python) PYTHON_BIN="$2"; shift 2 ;;
    --path-map) PATH_MAP="$2"; PATH_MAP_EXPLICIT=1; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# --ai-dir can come after --path-map on the command line; recompute the default
# unless the caller set the map explicitly.
if [ -z "${HBOTS_PATH_MAP:-}" ] && [ "${PATH_MAP_EXPLICIT:-0}" -eq 0 ]; then
  PATH_MAP="C:/Users/Ht=$HOME;C:/Claude/AI=$AI_DIR"
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "node not found; pass --node <path> or set HBOTS_NODE" >&2
  exit 1
fi
if [ -z "$PYTHON_BIN" ]; then PYTHON_BIN=/usr/bin/python3; fi

TARGET="$HOME/.config/systemd/user"
# The nightly dependency update and the upstream sync stay off unless someone
# enables them by hand. The upstream merge is deliberately blocked (orchestrator
# v2 is not merged) and the nightly pipeline is unproven on Linux; a reinstall
# must not turn either back on (26 Oct, after both were switched off live).
CORE_UNITS=(
  hbots.service
  tennis-poll.timer
  tennis-book.timer
  matchday-sofascore-fetcher.service
  docs-server.service
)
OPTIONAL_UNITS=(urgot.service cloudflared.service)
MANUAL_UNITS=(hbots-upstream-sync.timer hbots-nightly-updates.timer)

render() {
  sed -e "s|@REPO@|$REPO|g" \
      -e "s|@AI@|$AI_DIR|g" \
      -e "s|@NODE@|$NODE_BIN|g" \
      -e "s|@PYTHON@|$PYTHON_BIN|g" \
      -e "s|@PATH_MAP@|$PATH_MAP|g" \
      -e "s|@OPENCODE_BIN@|$OPENCODE_BIN_DIR|g" \
      -e "s|@HOME@|$HOME_DIR|g" "$1"
}

echo "repo   $REPO"
echo "ai     $AI_DIR"
echo "node   $NODE_BIN"
echo "python $PYTHON_BIN"
echo "map    $PATH_MAP"
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
  [ "$ENABLE" = 1 ] && echo "would enable and start: ${CORE_UNITS[*]}"
  exit 0
fi

systemctl --user daemon-reload
if [ "$ENABLE" = 1 ]; then
  # --now matters: without it the timers and the docs server stay inactive
  # until the next login, so scheduled work silently does not run after an
  # install (26 Oct: docs-server and all four timers were enabled but dead).
  systemctl --user enable --now "${CORE_UNITS[@]}"
  echo "Enabled and started: ${CORE_UNITS[*]}"
  echo "Left disabled on purpose: ${OPTIONAL_UNITS[*]} ${MANUAL_UNITS[*]}"
fi
