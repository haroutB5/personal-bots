#!/usr/bin/env bash
set -u
timeout 45 opencode models >/dev/null
code=$?
group=$(sed -n 's/^0:://p' /proc/self/cgroup)
count=0
for p in $(cat "/sys/fs/cgroup$group/cgroup.procs"); do
  [[ -r /proc/$p/cmdline ]] || continue
  mapfile -d '' -t args < "/proc/$p/cmdline"
  [[ ${args[0]-} == *opencode && ${args[1]-} == serve && ${args[2]-} == --service ]] && count=$((count+1))
done
printf 'models exit=%s leftover-services=%s\n' "$code" "$count"
[[ $code == 0 && $count == 0 ]]
