#!/usr/bin/env bash
# Shared by every checkout. Keep fd 9 inherited so a surviving job retains its lock.
set -euo pipefail
label='' workdir="$PWD" wait_seconds=10800
while (($#)); do
  case "$1" in
    --label) label=${2:?}; shift 2;;
    --work-dir) workdir=${2:?}; shift 2;;
    --wait-seconds) wait_seconds=${2:?}; shift 2;;
    --) shift; break;;
    *) echo 'Usage: heavy-job.sh --label NAME [--work-dir DIR] [--wait-seconds N] -- COMMAND [ARG...]' >&2; exit 2;;
  esac
done
[[ -n "$label" && $# -gt 0 && "$wait_seconds" =~ ^[0-9]+$ ]] || { echo 'Label and command required; wait must be seconds.' >&2; exit 2; }
cd -- "$workdir"
# A single machine path, independent of HOME, cwd, repo and XDG isolation.
lock=/home/harout/.personal-bots/run/omarchy-heavy.lock
if [[ -L "$lock" || ( -e "$lock" && ! -O "$lock" ) ]]; then
  echo 'Unsafe lock owner or symlink; ask the owner to provision the shared lock.' >&2; exit 2
fi
if [[ ${HBOTS_HEAVY_JOB_HELD:-} == 1 && -e /proc/$$/fd/9 ]] &&
   [[ $(readlink /proc/$$/fd/9) == "$lock" ]]; then
  exec "$@"
fi
umask 077
exec 9<>"$lock"
deadline=$((SECONDS + wait_seconds))
while ! flock -n 9; do
  printf 'heavy-job: waiting; holder: ' >&2
  cat "$lock" >&2
  ((SECONDS < deadline)) || exit 75
  remaining=$((deadline - SECONDS))
  ((remaining > 15)) && remaining=15
  flock -w "$remaining" 9 && break
done
printf 'pid=%s started=%s label=%q cwd=%q\n' "$$" "$(date -Is)" "$label" "$PWD" > "$lock"
export HBOTS_HEAVY_JOB_HELD=1
printf 'heavy-job: nice 10, ionice idle :: %s\n' "$label" >&2
# nice -n is relative; setpriority makes the inherited nice value exactly 10.
exec ionice -c 3 python3 -c 'import os,sys; os.setpriority(os.PRIO_PROCESS,0,10); os.execvp(sys.argv[1],sys.argv[1:])' "$@"
