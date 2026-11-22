/**
 * The script the stats server runs, sent over ssh stdin (see serverStats.ts).
 * A compile-time constant: nothing from a request, a client or the environment
 * is ever put into it.
 *
 * Read-only on the server. Per reading it reads the first line of /proc/stat,
 * two fields of /proc/meminfo and `df` of `/`, and writes one line to stdout:
 *
 *   hbs1 <user> <nice> <system> <idle> <iowait> <irq> <softirq> <steal>
 *        <MemTotal kB> <MemAvailable kB> <disk size bytes> <disk available bytes>
 *
 * (one line, single spaces; the disk pair is `- -` when `df` gave nothing).
 * The laptop works out CPU use from two readings, so the first reading comes
 * at once, the second a second later, then one every 5 s.
 *
 * It writes nothing, installs nothing and kills nothing. It ends by itself
 * after `max` readings (25 lines, about 2 minutes), a failed write (the laptop
 * went away) ends it at once, and the remote command runs it under
 * `timeout 170`, so neither a dropped link nor a stalled read leaves it running.
 */
export const SERVER_STATS_SCRIPT = String.raw`n=0
max=25
while :; do
  read -r _c u ni sy id io irq si st _r < /proc/stat
  m=$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print t+0, a+0}' /proc/meminfo)
  d=$(df -P -B1 / 2>/dev/null | awk 'NR==2{print $2+0, $4+0}')
  [ -n "$d" ] || d='- -'
  printf 'hbs1 %s %s %s %s %s %s %s %s %s %s\n' "$u" "$ni" "$sy" "$id" "$io" "$irq" "$si" "$st" "$m" "$d" || exit 0
  n=$((n+1))
  [ "$n" -ge "$max" ] && exit 0
  if [ "$n" -eq 1 ]; then sleep 1; else sleep 5; fi
done
`;
