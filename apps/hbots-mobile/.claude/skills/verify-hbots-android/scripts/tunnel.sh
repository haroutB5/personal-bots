#!/usr/bin/env bash
# tunnel.sh up | down: the quick tunnel from an https address to the throwaway server. The app only pairs over https.
# Runs as a systemd user unit named pstack-hbots-verify-tunnel-<run id>. The unit name and the URL go to the run's state file
# (TUNNEL_UNIT, TUNNEL_URL). The URL is never printed. down stops only the unit this run recorded.
# up reports "up" only after the public URL answers the server's environment route from outside, through the Cloudflare edge.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
touch "$STATE"
get() { grep -E "^$1=" "$STATE" 2>/dev/null | tail -1 | cut -d= -f2-; }
put() { { grep -vE "^$1=" "$STATE" 2>/dev/null; echo "$1=$2"; } > "$STATE.new"; mv "$STATE.new" "$STATE"; }
# probe <url> doh|local: one request to the server's environment route through the public URL. "doh" resolves the name through 1.1.1.1 over https
# and never asks this machine's resolver. A lookup of a brand new name that comes too early is cached as NXDOMAIN by systemd-resolved for about
# 60 s (measured), and the emulator most likely shares that cache (inferred), so the first lookups must not come from this machine.
probe() {
  local doh=(); [[ "$2" == doh ]] && doh=(--doh-url https://1.1.1.1/dns-query)
  curl -s "${doh[@]}" -o /dev/null -w '%{http_code}/%{exitcode}' --max-time 6 "$1/.well-known/t3/environment" 2>/dev/null
}
wait_answer() {
  local mode=$1 limit=$2 t0=$SECONDS
  code=000/0
  while [[ $((SECONDS - t0)) -lt $limit ]]; do
    systemctl --user is-active --quiet "$unit" || { echo "tunnel: cloudflared exited before the url answered (tunnel.log)"; exit 2; }
    code=$(probe "$u" "$mode"); echo "$(date -u +%T) $mode +$((SECONDS - t0))s http/curl-exit $code" >> "$LOGS/tunnel-probe.log"
    [[ "$code" == 200/0 ]] && return 0
    sleep 2
  done
  return 1
}
case "${1:-}" in
up)
  [[ -z "$(get TUNNEL_UNIT)" ]] || { echo "tunnel: this run already started $(get TUNNEL_UNIT)"; exit 2; }
  unit="pstack-hbots-verify-tunnel-${VERIFY_RUN_ID:-$(date -u +%Y%m%dT%H%M%S)-$$}"
  : > "$LOGS/tunnel.log"
  systemd-run --user --unit="$unit" --collect bash -c "cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$VERIFY_SERVER_PORT > $LOGS/tunnel.log 2>&1" >/dev/null || { echo "tunnel: systemd-run failed"; exit 2; }
  put TUNNEL_UNIT "$unit"
  for _ in $(seq 40); do u=$(grep -o -E 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOGS/tunnel.log" | head -1); [[ -n "$u" ]] && break; sleep 1; done
  [[ -n "${u:-}" ]] || { echo "tunnel: no url in 40 s (tunnel.log)"; exit 2; }
  t0=$SECONDS
  wait_answer doh 90 || { echo "tunnel: the url did not answer from outside in 90 s, last http/curl-exit $code (tunnel-probe.log, tunnel.log)"; exit 2; }
  wait_answer local 60 || { echo "tunnel: the url answers from outside but not through this machine's resolver in 60 s, last http/curl-exit $code (tunnel-probe.log)"; exit 2; }
  put TUNNEL_URL "$u"; echo "tunnel: up, answered http 200 from outside after $((SECONDS - t0)) s"
  ;;
down)
  unit=$(get TUNNEL_UNIT)
  if [[ -n "$unit" ]]; then
    systemctl --user stop "$unit" 2>/dev/null
    echo "tunnel: $unit $(systemctl --user is-active "$unit" 2>/dev/null)"
  else
    echo "tunnel: this run started none"
  fi
  sed -i '/^TUNNEL_URL=/d;/^TUNNEL_UNIT=/d' "$STATE" 2>/dev/null
  ;;
*) echo "usage: tunnel.sh up|down"; exit 2 ;;
esac
