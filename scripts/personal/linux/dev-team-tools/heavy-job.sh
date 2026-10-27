#!/usr/bin/env bash
# Shared by every checkout. Keep fds 8 and 9 inherited so a surviving job keeps both locks.
#
# Two kinds of holder share this gate:
#   - a normal job: SHARED flock on omarchy-heavy.lock (the release gate) plus an
#     EXCLUSIVE flock on one of the slot files (omarchy-heavy-1.lock, -2.lock);
#   - the release runner: EXCLUSIVE flock on omarchy-heavy.lock.
# So up to HEAVY_JOB_SLOTS jobs run at once, the hbots server's cap probe (which
# counts a shared lock as held) sees every one of them, and the runner cannot
# restart the server while any job is running. A third job waits for a slot
# without holding the gate, so it never starves a waiting release.
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
# Single machine paths, independent of HOME, cwd, repo and XDG isolation.
# HEAVY_JOB_BASE exists for tests: it must stay an absolute path.
base=${HEAVY_JOB_BASE:-/home/harout/.personal-bots/run/omarchy-heavy}
slots=${HEAVY_JOB_SLOTS:-2}
min_free_gb=${HEAVY_JOB_MIN_FREE_GB:-6}
main=$base.lock
[[ "$base" == /* ]] || { echo 'HEAVY_JOB_BASE must be an absolute path.' >&2; exit 2; }
[[ "$slots" =~ ^[12]$ && "$min_free_gb" =~ ^[0-9]+$ ]] || { echo 'HEAVY_JOB_SLOTS must be 1 or 2; HEAVY_JOB_MIN_FREE_GB a whole number.' >&2; exit 2; }
slot_for() { echo "$base-$1.lock"; }
# Slot 2 is taken only while MemAvailable is at least HEAVY_JOB_MIN_FREE_GB, so a
# second job never starves hbots on the 16 GB laptop.
mem_free_gb() { awk '/^MemAvailable:/ {print int($2 / 1048576)}' /proc/meminfo; }
try_slots() {
  local i l
  for ((i = 1; i <= slots; i++)); do
    if ((i > 1)) && (($(mem_free_gb) < min_free_gb)); then return 1; fi
    l=$(slot_for "$i")
    exec 9<>"$l"
    if flock -n 9; then lock=$l; return 0; fi
    exec 9>&-
  done
  return 1
}
print_holders() {
  local i
  printf 'heavy-job: waiting (%s slots busy or under %s GB free); holders:\n' "$slots" "$min_free_gb" >&2
  for ((i = 1; i <= slots; i++)); do cat "$(slot_for "$i")" >&2 2>/dev/null || true; done
  if [[ -e $main ]]; then printf 'gate: ' >&2; cat "$main" 2>/dev/null >&2 || true; fi
}
for ((i = 1; i <= slots; i++)); do
  l=$(slot_for "$i")
  if [[ -L "$l" || ( -e "$l" && ! -O "$l" ) ]]; then
    echo 'Unsafe lock owner or symlink; ask the owner to provision the shared lock.' >&2; exit 2
  fi
done
if [[ -e $main && ( -L $main || ! -O $main ) ]]; then
  echo 'Unsafe release-gate lock owner or symlink; ask the owner to provision it.' >&2; exit 2
fi
# Nested call inside a job that already holds both locks: just run the command.
if [[ ${HBOTS_HEAVY_JOB_HELD:-} == 1 && -e /proc/$$/fd/8 && -e /proc/$$/fd/9 ]] &&
   [[ $(readlink /proc/$$/fd/8) == "$main" && $(readlink /proc/$$/fd/9) == "$base-"*.lock ]]; then
  exec "$@"
fi
# A job started by the previous single-lock wrapper already owns the gate exclusively.
if [[ ${HBOTS_HEAVY_JOB_HELD:-} == 1 && -e /proc/$$/fd/9 ]] &&
   [[ $(readlink /proc/$$/fd/9) == "$main" ]]; then
  exec "$@"
fi
umask 077
deadline=$((SECONDS + wait_seconds))
# 1. A slot first: a job that cannot get one holds nothing, so it cannot keep a
#    release from starting.
until try_slots; do
  print_holders
  ((SECONDS < deadline)) || exit 75
  remaining=$((deadline - SECONDS))
  ((remaining > 15)) && remaining=15
  sleep "$remaining"
done
# 2. Then the shared release gate. The runner takes it exclusively for the
#    activation window, so every job (both slots) waits it out.
exec 8<>"$main"
while ! flock -s -n 8; do
  ((SECONDS < deadline)) || exit 75
  printf 'heavy-job: waiting for the release gate; holder: ' >&2
  cat "$main" >&2 || true
  remaining=$((deadline - SECONDS))
  ((remaining > 15)) && remaining=15
  if flock -s -w "$remaining" 8; then break; fi
done
label=${label//$'\n'/ }
printf 'pid=%s started=%s label=%s cwd=%s slot=%s\n' "$$" "$(date -Is)" "$label" "$PWD" "${lock##*-}" > "$lock"
export HBOTS_HEAVY_JOB_HELD=1
# nice -n is relative; setpriority makes the inherited nice value exactly 10.
prio=(ionice -c 3 python3 -c 'import os,sys; os.setpriority(os.PRIO_PROCESS,0,10); os.execvp(sys.argv[1],sys.argv[1:])')
# A soft memory ceiling in a scope of its own: past MemoryHigh the kernel
# reclaims from the job and slows it, never kills it, so the live server keeps
# its pages. Bot shells run inside hbots.service; without a scope a 6 GiB tsc
# competes with the server for the same cgroup. HEAVY_JOB_MEMORY_HIGH=off is the kill switch.
# --expand-environment=no: systemd-run would otherwise rewrite $$ and $VAR in the job's arguments.
high=${HEAVY_JOB_MEMORY_HIGH:-5G}
if [[ ! "$high" =~ ^(off|[1-9][0-9]*[KMG])$ ]]; then
  echo 'HEAVY_JOB_MEMORY_HIGH must be off or a size such as 6G.' >&2; exit 2
fi
if [[ "$high" != off ]]; then
  if systemd-run --user --scope --quiet --collect true 2>/dev/null; then
    printf 'heavy-job: nice 10, ionice idle, MemoryHigh %s :: %s\n' "$high" "$label" >&2
    exec systemd-run --user --scope --quiet --collect --expand-environment=no -p MemoryHigh="$high" -p CPUWeight=20 \
      --unit="heavy-job-$$" -- "${prio[@]}" "$@"
  fi
  echo 'heavy-job: systemd-run --user unavailable; running without a memory scope.' >&2
fi
printf 'heavy-job: nice 10, ionice idle :: %s\n' "$label" >&2
exec "${prio[@]}" "$@"
