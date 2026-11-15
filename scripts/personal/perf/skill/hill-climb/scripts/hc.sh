#!/usr/bin/env bash
# Team runner for the hill-climb skill. Use it everywhere SKILL.md says python3 "$CLIMB".
#   bash hc.sh <list|kits|init|try|status|holdout|raise|relock|review|budget|drop|save|reuse> ...
# Why a wrapper:
# - climb.py undoes a losing step with "git reset --hard" and "git clean -fd". In a shared checkout
#   that wipes other people's work, so changing commands run only inside a linked worktree.
# - Kits are kept in the team folder, not in each bot's home.
# - No .pyc files beside the skill, and Python ignores PYTHON* variables (-I).
# Pinned to upstream Bil0000/Hill-Climb 84b95909 (1.1.0). Update steps are in SKILL.md.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLIMB=$HERE/climb.py
export HILL_CLIMB_HOME=${HILL_CLIMB_HOME:-/home/harout/Claude/AI/dev-team/state/hill-climb}
export PYTHONDONTWRITEBYTECODE=1
mkdir -p "$HILL_CLIMB_HOME"

cmd=${1:-}
case $cmd in
  list | kits | status | save | review) ;;
  init | try | holdout | raise | relock | budget | drop | reuse)
    top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "hc.sh: run it inside the git worktree you climb in." >&2; exit 2; }
    gitdir=$(git rev-parse --absolute-git-dir)
    common=$(cd "$(git rev-parse --git-common-dir)" && pwd)
    if [ "$gitdir" = "$common" ]; then
      echo "hc.sh: $top is a main checkout. A climb resets and cleans its tree, so climb only in your own worktree (git worktree add .../_wt/<app>-climb-<name> -b climb/<name>)." >&2
      exit 2
    fi
    case $top in
      /home/harout/Claude/AI/personal-bots-sync | /home/harout/Claude/AI/personal-bots-sync/*)
        echo "hc.sh: the upstream sync worktree is off limits." >&2; exit 2 ;;
    esac
    ;;
  "" | -h | --help) exec python3 -I "$CLIMB" --help ;;
  *) echo "hc.sh: unknown command '$cmd'. See SKILL.md, section Commands." >&2; exit 2 ;;
esac
exec python3 -I "$CLIMB" "$@"
