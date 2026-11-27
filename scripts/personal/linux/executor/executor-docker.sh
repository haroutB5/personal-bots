#!/usr/bin/env bash
set -euo pipefail

IMAGE="${EXECUTOR_IMAGE:-ghcr.io/usefulsoftwareco/executor-selfhost:beta}"
CONTAINER_NAME="${EXECUTOR_CONTAINER_NAME:-hbots-executor}"
VOLUME_NAME="${EXECUTOR_VOLUME_NAME:-executor-v2-data}"
HOST_PORT="${EXECUTOR_PORT:-4400}"
AUTH_URL="${EXECUTOR_AUTH_URL:-http://localhost:${HOST_PORT}}"

usage() {
  cat <<'EOF'
Usage: executor-docker.sh <start|stop|status|logs>

Manages a local self-hosted Executor container bound strictly to 127.0.0.1:4400
with private-network fetches disabled (EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=false).

Environment overrides:
  EXECUTOR_IMAGE          Container image (default: ghcr.io/usefulsoftwareco/executor-selfhost:beta)
  EXECUTOR_CONTAINER_NAME Container name  (default: hbots-executor)
  EXECUTOR_VOLUME_NAME    Data volume     (default: executor-v2-data)
  EXECUTOR_PORT           Loopback port   (default: 4400)
  EXECUTOR_AUTH_URL       Better Auth URL (default: http://localhost:<EXECUTOR_PORT>)
EOF
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Error: docker is not installed or not in PATH." >&2
    exit 1
  fi
}

cmd_start() {
  require_docker
  if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    echo "Executor container '$CONTAINER_NAME' is already running on http://127.0.0.1:${HOST_PORT}."
    return 0
  fi

  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    docker start "$CONTAINER_NAME" >/dev/null
    echo "Started existing Executor container '$CONTAINER_NAME' on http://127.0.0.1:${HOST_PORT}."
    return 0
  fi

  docker volume create "$VOLUME_NAME" >/dev/null
  docker run -d \
    --init \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    -p "127.0.0.1:${HOST_PORT}:4400" \
    -e EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=false \
    -e "BETTER_AUTH_URL=${AUTH_URL}" \
    -v "${VOLUME_NAME}:/app/data" \
    "$IMAGE" >/dev/null

  echo "Started Executor container '$CONTAINER_NAME' on http://127.0.0.1:${HOST_PORT}."
}

cmd_stop() {
  require_docker
  if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    docker stop "$CONTAINER_NAME" >/dev/null
    echo "Stopped Executor container '$CONTAINER_NAME'."
  else
    echo "Executor container '$CONTAINER_NAME' is not running."
  fi
}

cmd_status() {
  require_docker
  if docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E "^${CONTAINER_NAME}\b"; then
    return 0
  else
    echo "Executor container '$CONTAINER_NAME' does not exist."
    return 1
  fi
}

cmd_logs() {
  require_docker
  docker logs --tail 100 -f "$CONTAINER_NAME"
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  -h|--help|help|"") usage ;;
  *)
    echo "Unknown command: $1" >&2
    usage >&2
    exit 2
    ;;
esac
