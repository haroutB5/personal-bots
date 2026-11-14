#!/usr/bin/env bash
# Runs Modern Web Guidance from one pinned local install: no npx, no network, no telemetry.
#   mwg.sh search "<2-5 word query>"     -> [{ "id", "description" }, ...]
#   mwg.sh retrieve "<id>[,<id>...]"     -> the full guide(s)
#   mwg.sh list                          -> every guide id
#   mwg.sh legacy-scan <path> --json     -> legacy patterns (only for a broad modernization ask)
# Pinned on purpose: upstream publishes almost daily (121 versions by 14 Nov 2026) and "npx @latest"
# would download and run new code on every call. Bump VERSION only through the steps in SKILL.md.
set -euo pipefail
VERSION=1.0.0
ROOT=${MWG_HOME:-/home/harout/Claude/AI/dev-team/tools/modern-web-guidance}
DIR=$ROOT/$VERSION/node_modules/modern-web-guidance/skills/modern-web-guidance
CLI=$DIR/modern-web.mjs
# Large guides are written to a file under TMPDIR. Team rule: scratch files stay out of /tmp. Old ones are pruned.
OUT=${MWG_OUT:-/home/harout/Claude/AI/dev-team/qa/_mwg-out}
mkdir -p "$OUT" && find "$OUT" -maxdepth 1 -name 'mwg-guide-*' -mmin +1440 -delete 2>/dev/null || true
export TMPDIR=$OUT
# Upstream sends search queries and guide ids to Google unless this is set. It must stay set.
export DISABLE_TELEMETRY=1
if [ ! -f "$CLI" ]; then
  echo "modern-web-guidance $VERSION is not installed at $ROOT/$VERSION. Tell the lead; see SKILL.md, section Install." >&2
  exit 3
fi
cmd=${1:-}
case $cmd in
  search) exec node "$CLI" "$@" --skill-version "$(cat "$DIR/skill-version.txt")" ;;
  retrieve | list | legacy-scan) exec node "$CLI" "$@" ;;
  *) echo "usage: mwg.sh search|retrieve|list|legacy-scan ..." >&2; exit 2 ;;
esac
