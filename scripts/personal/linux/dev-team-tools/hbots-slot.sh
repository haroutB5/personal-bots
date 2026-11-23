#!/usr/bin/env bash
# hbots-slot.sh: the two fixed hbots release slots (Faster releases step 5, Harout 22 Nov 2026).
#
# The slots /home/harout/Claude/AI/_wt/hbots-slot-1 and hbots-slot-2 are permanent worktrees of
# the hbots repo. A release task leases one, switches it to its branch with `git switch`, builds
# there, and releases it. Gitignored build caches (node_modules, android/ with its Gradle outputs
# and native fingerprint, .env) stay in the slot, so the next build is warm.
#
#   hbots-slot.sh lease --label TEXT [--slot N] [--wait-seconds S]   prints the slot path
#   hbots-slot.sh switch --slot N --label TEXT (--branch NAME --from REF | --detach REF) [--install]
#   hbots-slot.sh release --slot N --label TEXT
#   hbots-slot.sh status
#
# A lease is a file run/hbots-slots/slot-N.lease (label, time, holder), made and removed under a
# flock, so a lease lasts across the many shell commands of one task. Only the label that took a
# lease can switch or release it. A lease older than 24 h is reported as stale and never taken
# over silently: release it with --label of the holder.
#
# switch refuses tracked changes, then runs `git switch` and `git clean -fd`. `git clean -fd`
# (never -x) runs on these slot paths only: Harout's explicit approval, guard 1. .env is
# gitignored, so it stays; a slot without one gets a copy from the main checkout (never printed).
# --install runs `pnpm install --frozen-lockfile` when the lockfile changed.
set -euo pipefail

SLOT_ROOT=${HBOTS_SLOT_ROOT:-/home/harout/Claude/AI/_wt}
REPO=${HBOTS_SLOT_REPO:-/home/harout/Claude/AI/personal-bots}
STATE=${HBOTS_SLOT_STATE:-/home/harout/.personal-bots/run/hbots-slots}
SLOTS=(1 2)
STALE_SECONDS=86400

die() { echo "hbots-slot: $*" >&2; exit 1; }
usage() { sed -n '9,13p' "$0" | sed 's/^# //' >&2; exit 2; }

cmd=${1:-}; [[ -n $cmd ]] || usage; shift
label='' slot='' branch='' from='' detach='' install=0 wait_seconds=0
while (($#)); do
  case $1 in
    --label) label=${2:?}; shift 2;;
    --slot) slot=${2:?}; shift 2;;
    --branch) branch=${2:?}; shift 2;;
    --from) from=${2:?}; shift 2;;
    --detach) detach=${2:?}; shift 2;;
    --install) install=1; shift;;
    --wait-seconds) wait_seconds=${2:?}; shift 2;;
    *) usage;;
  esac
done
[[ -z $slot || $slot =~ ^[12]$ ]] || die "--slot must be 1 or 2"
[[ $label != *$'\n'* ]] || die "--label must be one line"

mkdir -p "$STATE"
chmod 700 "$STATE"
exec 8>"$STATE/.lock"

slot_path() { printf '%s/hbots-slot-%s' "$SLOT_ROOT" "$1"; }
lease_file() { printf '%s/slot-%s.lease' "$STATE" "$1"; }
lease_label() { sed -n 's/^label=//p' "$(lease_file "$1")" 2>/dev/null | head -n 1; }
lease_age() {
  local since
  since=$(sed -n 's/^since=//p' "$(lease_file "$1")" 2>/dev/null | head -n 1)
  [[ $since =~ ^[0-9]+$ ]] || { echo 0; return; }
  echo $(( $(date +%s) - since ))
}
g() { git -C "$(slot_path "$1")" -c user.email=harout_b5@live.com -c user.name=haroutB5 "${@:2}"; }

# The guard on git clean: only a real slot worktree of the hbots repo, by its exact path.
assert_slot() {
  local path real
  path=$(slot_path "$1")
  [[ -d $path ]] || die "slot $1 is missing at $path; create it with: git -C $REPO worktree add --detach $path personal-bots/main"
  real=$(realpath -- "$path")
  # The tests run on a throwaway repo under /tmp/hbots-slot-test.*; nothing else passes.
  [[ $real =~ ^/home/harout/Claude/AI/_wt/hbots-slot-[12]$ || ( -n ${HBOTS_SLOT_TEST:-} && $real =~ ^/tmp/hbots-slot-test\.[A-Za-z0-9]+/wt/hbots-slot-[12]$ ) ]] ||
    die "refusing: $real is not a release slot path"
  [[ $(git -C "$real" rev-parse --show-toplevel) == "$real" ]] || die "refusing: $real is not a worktree root"
  [[ $(realpath -- "$(git -C "$real" rev-parse --path-format=absolute --git-common-dir)") == $(realpath -- "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)") ]] ||
    die "refusing: $real is not a worktree of $REPO"
}

holds() {
  [[ -f $(lease_file "$1") ]] || die "slot $1 is not leased; lease it first"
  [[ $(lease_label "$1") == "$label" ]] || die "slot $1 is leased by '$(lease_label "$1")', not '$label'"
}

case $cmd in
  status)
    flock 8
    for n in "${SLOTS[@]}"; do
      path=$(slot_path "$n")
      head='missing'
      [[ -d $path ]] && head=$(git -C "$path" log -1 --format='%h %s' 2>/dev/null | cut -c1-60)
      if [[ -f $(lease_file "$n") ]]; then
        age=$(lease_age "$n")
        printf 'slot %s %s: leased by "%s" for %s s%s; at %s\n' "$n" "$path" "$(lease_label "$n")" "$age" \
          "$( ((age > STALE_SECONDS)) && echo ' (STALE: over 24 h)')" "$head"
      else
        printf 'slot %s %s: free; at %s\n' "$n" "$path" "$head"
      fi
    done
    ;;
  lease)
    [[ -n $label ]] || die "lease needs --label"
    deadline=$(( $(date +%s) + wait_seconds ))
    while :; do
      flock 8
      for n in ${slot:-${SLOTS[@]}}; do
        if [[ ! -f $(lease_file "$n") ]]; then
          assert_slot "$n"
          tmp=$(mktemp "$STATE/.lease.XXXXXX")
          printf 'label=%s\nsince=%s\nstarted=%s\nholder_pid=%s\n' "$label" "$(date +%s)" "$(date -Is)" "$PPID" >"$tmp"
          mv -n "$tmp" "$(lease_file "$n")"
          [[ -f $tmp ]] && { rm -f "$tmp"; continue; }
          echo "leased slot $n" >&2
          slot_path "$n"; echo
          exit 0
        fi
      done
      flock -u 8
      (( $(date +%s) < deadline )) || die "no free slot ($(for n in ${slot:-${SLOTS[@]}}; do printf 'slot %s: %s; ' "$n" "$(lease_label "$n")"; done))"
      sleep 10
    done
    ;;
  switch)
    [[ -n $slot && -n $label ]] || die "switch needs --slot and --label"
    [[ -n $detach || ( -n $branch && -n $from ) ]] || die "switch needs --branch NAME --from REF, or --detach REF"
    flock 8
    holds "$slot"
    assert_slot "$slot"
    [[ -z $(g "$slot" status --porcelain --untracked-files=no) ]] || die "slot $slot has tracked changes; commit or stash them first"
    before_lock=$(g "$slot" rev-parse -q --verify 'HEAD:pnpm-lock.yaml' 2>/dev/null || true)
    if [[ -n $detach ]]; then
      g "$slot" switch --detach "$detach"
    else
      g "$slot" switch -C "$branch" "$from"
    fi
    # Harout's guard 1: untracked files must not leak from one release to the next. Never -x.
    g "$slot" clean -fd
    path=$(slot_path "$slot")
    if [[ ! -f $path/.env && -f $REPO/.env ]]; then
      cp "$REPO/.env" "$path/.env"
      chmod 600 "$path/.env"
      echo "hbots-slot: copied .env from the main checkout" >&2
    fi
    after_lock=$(g "$slot" rev-parse -q --verify 'HEAD:pnpm-lock.yaml' 2>/dev/null || true)
    if [[ $install == 1 && ( $before_lock != "$after_lock" || ! -d $path/node_modules ) ]]; then
      echo "hbots-slot: lockfile changed; pnpm install --frozen-lockfile" >&2
      (cd "$path" && env -u NODE_ENV pnpm install --frozen-lockfile)
    fi
    echo "slot $slot at $(g "$slot" log -1 --format='%h %s' | cut -c1-72)"
    ;;
  release)
    [[ -n $slot && -n $label ]] || die "release needs --slot and --label"
    flock 8
    holds "$slot"
    rm -f "$(lease_file "$slot")"
    echo "released slot $slot"
    ;;
  *) usage;;
esac
