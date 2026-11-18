#!/usr/bin/env bash
# tunnel.sh up | down: the quick tunnel from an https address to the throwaway server. The app only pairs over https.
# Runs as the systemd user unit pstack-hbots-verify-tunnel. The URL is written to .scratch/state.env as TUNNEL_URL and is never printed.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
touch "$STATE"
put() { { grep -vE "^$1=" "$STATE" 2>/dev/null; echo "$1=$2"; } > "$STATE.new"; mv "$STATE.new" "$STATE"; }
case "${1:-}" in
up)
  : > "$S/logs/tunnel.log"
  systemd-run --user --unit=pstack-hbots-verify-tunnel --collect bash -c "cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$VERIFY_SERVER_PORT > $S/logs/tunnel.log 2>&1" >/dev/null
  for _ in $(seq 40); do u=$(grep -o -E 'https://[a-z0-9-]+\.trycloudflare\.com' "$S/logs/tunnel.log" | head -1); [[ -n "$u" ]] && break; sleep 1; done
  [[ -n "${u:-}" ]] || { echo "tunnel: no url in 40 s (logs/tunnel.log)"; exit 2; }
  put TUNNEL_URL "$u"; echo "tunnel: up"
  ;;
down)
  systemctl --user stop pstack-hbots-verify-tunnel 2>/dev/null
  sed -i '/^TUNNEL_URL=/d' "$STATE" 2>/dev/null
  echo "tunnel: $(systemctl --user is-active pstack-hbots-verify-tunnel 2>/dev/null)"
  ;;
*) echo "usage: tunnel.sh up|down"; exit 2 ;;
esac
