#!/usr/bin/env bash
# Runs `opencode models` the way a bot shell does and counts `serve --service` processes left in this unit's cgroup.
# The raw CLI starts that service a few seconds AFTER `models` exits, so the count waits for it.
# Usage (inside a throwaway unit, PATH decides raw vs wrapped): bash opencode-shell-fixture.sh [--expect-leftover]
set -u
expect_leftover=0; [[ ${1-} == --expect-leftover ]] && expect_leftover=1
timeout 45 opencode models >/dev/null
code=$?
sleep 8
group=$(sed -n 's/^0:://p' /proc/self/cgroup)
count=0
for p in $(cat "/sys/fs/cgroup$group/cgroup.procs"); do
  [[ -r /proc/$p/cmdline ]] || continue
  mapfile -d '' -t args < "/proc/$p/cmdline" 2>/dev/null || continue
  [[ ${args[0]-} == *opencode* && ${args[1]-} == serve && ${args[2]-} == --service ]] && count=$((count+1))
done
printf 'models exit=%s leftover-services=%s\n' "$code" "$count"
[[ $code == 0 ]] || exit 1
if ((expect_leftover)); then ((count > 0)); else ((count == 0)); fi
