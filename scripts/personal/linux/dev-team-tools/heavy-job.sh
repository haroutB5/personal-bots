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
label='' workdir="$PWD" wait_seconds=10800 lane=light
while (($#)); do
  case "$1" in
    --label) label=${2:?}; shift 2;;
    --lane) lane=${2:?}; shift 2;;
    --work-dir) workdir=${2:?}; shift 2;;
    --wait-seconds) wait_seconds=${2:?}; shift 2;;
    --) shift; break;;
    *) echo 'Usage: heavy-job.sh --label NAME [--lane light|android] [--work-dir DIR] [--wait-seconds N] -- COMMAND [ARG...]' >&2; exit 2;;
  esac
done
[[ -n "$label" && $# -gt 0 && "$wait_seconds" =~ ^[0-9]+$ ]] || { echo 'Label and command required; wait must be seconds.' >&2; exit 2; }
# Two lanes (Faster releases step 6, 22 Nov 2026). light: tests, typechecks, installs;
# up to HEAVY_JOB_SLOTS at once. android: Gradle and the emulator; it also holds one
# exclusive Android lock, so only one Gradle build or emulator runs at a time (Harout's
# guard 4) while light jobs keep running beside it.
[[ "$lane" == light || "$lane" == android ]] || { echo 'heavy-job: --lane must be light or android.' >&2; exit 2; }
cd -- "$workdir"
# Fail fast and plainly when the command cannot start, before taking a slot: otherwise
# the exec deep inside the memory scope dies with a Python traceback (Opuser, 22 Nov,
# `vp` is not on PATH; it lives in node_modules/.bin).
if [[ "$1" == */* ]]; then
  [[ -f "$1" && -x "$1" ]] || { echo "heavy-job: '$1' is not an executable file (from $PWD)." >&2; exit 127; }
elif ! type -P -- "$1" >/dev/null; then
  echo "heavy-job: command '$1' is not on PATH. Repo tools such as vp live in node_modules/.bin: run 'pnpm exec $1 ...' (or 'npx $1 ...') from the package folder, or 'bash -c \"...\"'." >&2
  exit 127
fi
# Single machine paths, independent of HOME, cwd, repo and XDG isolation.
# HEAVY_JOB_BASE exists for tests: it must stay an absolute path.
base=${HEAVY_JOB_BASE:-/home/harout/.personal-bots/run/omarchy-heavy}
slots=${HEAVY_JOB_SLOTS:-4}
min_free_gb=${HEAVY_JOB_MIN_FREE_GB:-6}
main=$base.lock
android_lock=$base-android.lock
[[ "$base" == /* ]] || { echo 'HEAVY_JOB_BASE must be an absolute path.' >&2; exit 2; }
[[ "$slots" =~ ^[1-8]$ && "$min_free_gb" =~ ^[0-9]+$ ]] || { echo 'HEAVY_JOB_SLOTS must be 1 to 8; HEAVY_JOB_MIN_FREE_GB a whole number.' >&2; exit 2; }
slot_for() { echo "$base-$1.lock"; }
# Slots 2 and up are taken only while MemAvailable is at least HEAVY_JOB_MIN_FREE_GB,
# so extra jobs never starve hbots. 4 slots by default on the 31 GB laptop (Harout, 19 Nov).
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
if [[ -e $android_lock && ( -L $android_lock || ! -O $android_lock ) ]]; then
  echo 'Unsafe Android lane lock owner or symlink; ask the owner to provision it.' >&2; exit 2
fi
holds_android() { [[ -e /proc/$$/fd/7 && $(readlink /proc/$$/fd/7) == "$android_lock" ]]; }
# The Android lane lock, waited for in the foreground. Fd 7 is inherited by the job.
take_android() {
  [[ "$lane" == android ]] || return 0
  holds_android && return 0
  exec 7<>"$android_lock"
  while ! flock -n 7; do
    printf 'heavy-job: waiting for the Android lane (one Gradle build or emulator at a time); holder: ' >&2
    cat "$android_lock" >&2 2>/dev/null || echo >&2
    ((SECONDS < deadline)) || exit 75
    remaining=$((deadline - SECONDS))
    ((remaining > 15)) && remaining=15
    if flock -w "$remaining" 7; then break; fi
  done
  printf 'pid=%s started=%s label=%s cwd=%s lane=android\n' "$$" "$(date -Is)" "${label//$'\n'/ }" "$PWD" > "$android_lock"
}
# Nested call inside a job that already holds both locks: just run the command.
if [[ ${HBOTS_HEAVY_JOB_HELD:-} == 1 && -e /proc/$$/fd/8 && -e /proc/$$/fd/9 ]] &&
   [[ $(readlink /proc/$$/fd/8) == "$main" && $(readlink /proc/$$/fd/9) == "$base-"*.lock ]]; then
  deadline=$((SECONDS + wait_seconds)); take_android
  exec "$@"
fi
# A job started by the previous single-lock wrapper already owns the gate exclusively.
if [[ ${HBOTS_HEAVY_JOB_HELD:-} == 1 && -e /proc/$$/fd/9 ]] &&
   [[ $(readlink /proc/$$/fd/9) == "$main" ]]; then
  deadline=$((SECONDS + wait_seconds)); take_android
  exec "$@"
fi
umask 077
deadline=$((SECONDS + wait_seconds))
# 0. An armed release waits for idle. With 4 slots new jobs could keep it waiting
#    for ever, so no new job starts while an hbots-release-run unit is active
#    (Poteto, 19 Nov). Running jobs finish normally. Only the live lock base is
#    checked, so tests with their own HEAVY_JOB_BASE are not affected.
release_armed() {
  [[ ( "$base" == /home/harout/.personal-bots/run/omarchy-heavy || ${HEAVY_JOB_RELEASE_CHECK:-} == 1 ) && ${HEAVY_JOB_IGNORE_RELEASE:-} != 1 ]] || return 1
  [[ -n $(systemctl --user list-units --state=active --plain --no-legend 'hbots-release-run-*.service' 2>/dev/null) ]]
}
while release_armed; do
  echo 'heavy-job: an hbots release is armed and waiting for idle; new jobs wait until it lands.' >&2
  ((SECONDS < deadline)) || exit 75
  remaining=$((deadline - SECONDS))
  ((remaining > 30)) && remaining=30
  sleep "$remaining"
done
# 0b. An android job takes the Android lane before a slot, so waiting for the lane
#     never holds a slot or the release gate.
take_android
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
printf 'pid=%s started=%s label=%s cwd=%s slot=%s lane=%s\n' "$$" "$(date -Is)" "$label" "$PWD" "${lock##*-}" "$lane" > "$lock"
export HBOTS_HEAVY_JOB_HELD=1
# nice -n is relative; setpriority makes the inherited nice value exactly 10.
prio=(ionice -c 3 python3 -c 'import os,sys; os.setpriority(os.PRIO_PROCESS,0,10); os.execvp(sys.argv[1],sys.argv[1:])')
# A memory scope of its own. MemoryHigh softens the job past 7G so the live server
# keeps its pages. MemoryMax and MemorySwapMax are the hard ceiling: past 8G RAM
# plus 8G swap the kernel kills the job inside this scope, so a runaway build or
# emulator cannot push the box to 90% swap and take hbots with it. A Gradle APK
# build fits these defaults. On the 31 GB laptop with 62 GB swap, four jobs at the
# swap cap use about half the swap, and no extra slot starts under the free-RAM
# floor. Any cap accepts off, which restores the old behaviour; MemoryHigh=off
# also runs without a scope at all.
# --expand-environment=no: systemd-run would otherwise rewrite $$ and $VAR in the job's arguments.
high=${HEAVY_JOB_MEMORY_HIGH:-7G}
max=${HEAVY_JOB_MEMORY_MAX:-8G}
swap=${HEAVY_JOB_SWAP_MAX:-8G}
# Optional hard CPU cap for the whole scope, as systemd's CPUQuota (700% is 7 cores).
cpu_quota=${HEAVY_JOB_CPU_QUOTA:-off}
size_re='^(off|[1-9][0-9]*[KMG])$'
[[ "$cpu_quota" =~ ^(off|[1-9][0-9]*%)$ ]] || { echo 'HEAVY_JOB_CPU_QUOTA must be off or a percentage such as 700%.' >&2; exit 2; }
[[ "$high" =~ $size_re ]] || { echo 'HEAVY_JOB_MEMORY_HIGH must be off or a size such as 6G.' >&2; exit 2; }
[[ "$max" =~ $size_re ]] || { echo 'HEAVY_JOB_MEMORY_MAX must be off or a size such as 6G.' >&2; exit 2; }
[[ "$swap" =~ $size_re ]] || { echo 'HEAVY_JOB_SWAP_MAX must be off or a size such as 4G.' >&2; exit 2; }
if [[ "$high" != off ]]; then
  if systemd-run --user --scope --quiet --collect true 2>/dev/null; then
    printf 'heavy-job: nice 10, ionice idle, MemoryHigh %s, MemoryMax %s, MemorySwapMax %s%s, lane %s :: %s\n' "$high" "$max" "$swap" "$([[ $cpu_quota == off ]] || printf ', CPUQuota %s' "$cpu_quota")" "$lane" "$label" >&2
    caps=(-p MemoryHigh="$high" -p CPUWeight=20)
    [[ "$cpu_quota" == off ]] || caps+=(-p CPUQuota="$cpu_quota")
    [[ "$max" == off ]] || caps+=(-p MemoryMax="$max")
    [[ "$swap" == off ]] || caps+=(-p MemorySwapMax="$swap")
    exec systemd-run --user --scope --quiet --collect --expand-environment=no "${caps[@]}" \
      --unit="heavy-job-$$" -- "${prio[@]}" "$@"
  fi
  echo 'heavy-job: systemd-run --user unavailable; running without a memory scope.' >&2
fi
printf 'heavy-job: nice 10, ionice idle :: %s\n' "$label" >&2
exec "${prio[@]}" "$@"
