#!/usr/bin/env bash
#
# verify.sh - health checks for the hbots baseline on Omarchy.
#
#   ./verify.sh
#   ./verify.sh --json
#   ./verify.sh --user harout --repo /home/harout/Claude/AI/personal-bots
#   ./verify.sh --dry-run
#   ./verify.sh --skip-apps        # base host only: Kino and docs are not installed yet
#
# Prints a PASS/FAIL table and exits 0 only when every check passed.
# --json prints machine-readable JSON instead of the table.
# --dry-run lists the checks without touching the machine and exits 0.
# A unit whose systemd condition is not met (its app is not installed yet) is
# reported as SKIP, not FAIL.
#
# Read-only: this script never restarts, writes or deletes anything.
#
set -u

DRY_RUN=0
JSON=0
SKIP_APPS=0
USER_ARG=""
REPO_ARG=""
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --json)
      JSON=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-apps)
      SKIP_APPS=1
      shift
      ;;
    --user)
      [ "$#" -ge 2 ] || { echo "ERROR: --user needs a value." >&2; exit 2; }
      USER_ARG="$2"
      shift 2
      ;;
    --repo)
      [ "$#" -ge 2 ] || { echo "ERROR: --repo needs a value." >&2; exit 2; }
      REPO_ARG="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1 (use --help)" >&2
      exit 2
      ;;
  esac
done

if [ -n "$USER_ARG" ]; then
  TARGET_USER="$USER_ARG"
elif [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
  TARGET_USER="$SUDO_USER"
else
  TARGET_USER="$(id -un)"
fi

if [ -n "$REPO_ARG" ]; then
  REPO="$REPO_ARG"
else
  REPO="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
fi

TARGET_HOME="$(getent passwd "$TARGET_USER" 2>/dev/null | cut -d: -f6 || true)"
[ -n "$TARGET_HOME" ] || TARGET_HOME="/home/$TARGET_USER"

UNIT_DIR="$REPO/scripts/personal/linux/systemd"
# Command overrides exist so the test suite can run the whole script against
# fakes. They default to the normal commands and are not needed in production.
CURL_BIN="${VERIFY_CURL:-curl}"
SYSTEMCTL_BIN="${VERIFY_SYSTEMCTL:-systemctl}"
DF_BIN="${VERIFY_DF:-df}"
SENSORS_BIN="${VERIFY_SENSORS:-sensors}"
INSTALLED_UNIT_DIR="${VERIFY_INSTALLED_UNIT_DIR:-$TARGET_HOME/.config/systemd/user}"
CHECK_NAMES=()
CHECK_STATUS=()
CHECK_DETAIL=()

add_check() {
  CHECK_NAMES+=("$1")
  CHECK_STATUS+=("$2")
  CHECK_DETAIL+=("$3")
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

user_systemctl() {
  local uid
  uid="$(id -u "$TARGET_USER" 2>/dev/null || true)"
  if [ -z "$uid" ]; then
    return 127
  fi
  if [ "$(id -u)" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
    if command -v runuser >/dev/null 2>&1; then
      runuser -u "$TARGET_USER" -- env "XDG_RUNTIME_DIR=/run/user/$uid" "$SYSTEMCTL_BIN" --user "$@"
    else
      return 127
    fi
  else
    env "XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$uid}" "$SYSTEMCTL_BIN" --user "$@"
  fi
}

check_units() {
  local -a units=()
  local unit installed rendered
  if [ -d "$UNIT_DIR" ]; then
    while IFS= read -r unit; do
      rendered="$(basename "$unit")"
      units+=("${rendered%.in}")
    done < <(find "$UNIT_DIR" -maxdepth 1 -type f \( -name '*.service' -o -name '*.service.in' \) | sort)
  fi

  if [ "${#units[@]}" -eq 0 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      add_check "systemd user units" "SKIP" "no *.service(.in) under $UNIT_DIR (dry run)"
    else
      add_check "systemd user units" "FAIL" "no *.service(.in) under $UNIT_DIR"
    fi
    return
  fi

  for unit in "${units[@]}"; do
    if [ "$DRY_RUN" -eq 1 ]; then
      add_check "systemd: $unit" "SKIP" "would check systemctl --user is-active"
      continue
    fi
    installed="$INSTALLED_UNIT_DIR/$unit"
    if [ ! -f "$installed" ]; then
      add_check "systemd: $unit" "FAIL" "not installed ($installed)"
    elif ! user_systemctl is-active --quiet "$unit"; then
      # An unmet ConditionPathExists means the app is not restored yet: that is
      # a skip on a base host, not a failed service.
      if [ "$(user_systemctl show "$unit" -p ConditionResult --value 2>/dev/null)" = "no" ]; then
        add_check "systemd: $unit" "SKIP" "condition not met (app not installed)"
      else
        add_check "systemd: $unit" "FAIL" "not active as $TARGET_USER"
      fi
    else
      add_check "systemd: $unit" "PASS" "active"
    fi
  done
}

check_hbots() {
  if [ "$DRY_RUN" -eq 1 ]; then
    add_check "hbots HTTP 38472" "SKIP" "would GET /.well-known/t3/environment"
    return
  fi
  if ! command -v "$CURL_BIN" >/dev/null 2>&1; then
    add_check "hbots HTTP 38472" "FAIL" "curl is missing"
    return
  fi
  local body
  body="$("$CURL_BIN" -fsS --max-time 5 http://127.0.0.1:38472/.well-known/t3/environment 2>/dev/null || true)"
  if [ -n "$body" ]; then
    add_check "hbots HTTP 38472" "PASS" "GET /.well-known/t3/environment returned a body"
  else
    add_check "hbots HTTP 38472" "FAIL" "GET /.well-known/t3/environment failed"
  fi
}

check_http_port() {
  local name="$1" port="$2" app_dir="${3:-}"
  if [ -n "$app_dir" ] && [ ! -d "$app_dir" ]; then
    add_check "$name HTTP $port" "SKIP" "app not installed ($app_dir)"
    return
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    add_check "$name HTTP $port" "SKIP" "would probe 127.0.0.1:$port"
    return
  fi
  if ! command -v "$CURL_BIN" >/dev/null 2>&1; then
    add_check "$name HTTP $port" "FAIL" "curl is missing"
    return
  fi
  local code
  code="$("$CURL_BIN" -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/" 2>/dev/null || true)"
  if [ -n "$code" ] && [ "$code" != "000" ]; then
    add_check "$name HTTP $port" "PASS" "HTTP $code"
  else
    add_check "$name HTTP $port" "FAIL" "no HTTP response on 127.0.0.1:$port"
  fi
}

check_sensors() {
  if [ "$DRY_RUN" -eq 1 ]; then
    add_check "sensors present" "SKIP" "would check command -v sensors"
    return
  fi
  if command -v "$SENSORS_BIN" >/dev/null 2>&1; then
    add_check "sensors present" "PASS" "$(command -v "$SENSORS_BIN")"
  else
    add_check "sensors present" "FAIL" "lm_sensors is not installed"
  fi
}

check_cloudflared() {
  if [ "$DRY_RUN" -eq 1 ]; then
    add_check "cloudflared active" "SKIP" "would check the process and user/system units"
    return
  fi
  # hbots spawns and supervises its own tunnel, so a process is the normal
  # state; a separate unit only exists when hbots does not manage one.
  if pgrep -f 'cloudflared.*tunnel' >/dev/null 2>&1; then
    add_check "cloudflared active" "PASS" "tunnel process running (managed by hbots)"
    return
  fi
  if user_systemctl is-active --quiet cloudflared.service 2>/dev/null; then
    add_check "cloudflared active" "PASS" "user unit active"
    return
  fi
  if "$SYSTEMCTL_BIN" is-active --quiet cloudflared.service 2>/dev/null; then
    add_check "cloudflared active" "PASS" "system unit active"
    return
  fi
  add_check "cloudflared active" "SKIP" "no tunnel running (hbots starts one once T3 Connect is linked)"
}

check_disk() {
  if [ "$DRY_RUN" -eq 1 ]; then
    add_check "disk space" "SKIP" "would require 5 GiB free on /"
    return
  fi
  local avail_kb threshold_kb
  avail_kb="$("$DF_BIN" -Pk / 2>/dev/null | awk 'NR==2 {print $4}')"
  threshold_kb=$((5 * 1024 * 1024))
  if [ -z "$avail_kb" ]; then
    add_check "disk space" "FAIL" "df could not read /"
    return
  fi
  if [ "$avail_kb" -ge "$threshold_kb" ]; then
    add_check "disk space" "PASS" "$(awk -v k="$avail_kb" 'BEGIN {printf "%.1f GiB free", k/1048576}')"
  else
    add_check "disk space" "FAIL" "$(awk -v k="$avail_kb" 'BEGIN {printf "only %.1f GiB free, need 5 GiB", k/1048576}')"
  fi
}

check_units
check_hbots
if [ "$SKIP_APPS" -eq 1 ]; then
  add_check "Kino HTTP 5186" "SKIP" "--skip-apps"
  add_check "docs HTTP 8765" "SKIP" "--skip-apps"
else
  check_http_port "Kino" 5186 "$TARGET_HOME/Claude/AI/kino-der-toten"
  check_http_port "docs" 8765 "$TARGET_HOME/Claude/AI/dev-team"
fi
check_sensors
check_cloudflared
check_disk

failed=0
for status in "${CHECK_STATUS[@]}"; do
  if [ "$status" = "FAIL" ]; then
    failed=$((failed + 1))
  fi
done

if [ "$JSON" -eq 1 ]; then
  printf '{"ok":%s,"dryRun":%s,"user":"%s","repo":"%s","checks":[' \
    "$([ "$failed" -eq 0 ] && echo true || echo false)" \
    "$([ "$DRY_RUN" -eq 1 ] && echo true || echo false)" \
    "$(json_escape "$TARGET_USER")" \
    "$(json_escape "$REPO")"
  first=1
  for i in "${!CHECK_NAMES[@]}"; do
    if [ "$first" -eq 0 ]; then
      printf ','
    fi
    first=0
    printf '{"name":"%s","status":"%s","detail":"%s"}' \
      "$(json_escape "${CHECK_NAMES[$i]}")" \
      "$(json_escape "${CHECK_STATUS[$i]}")" \
      "$(json_escape "${CHECK_DETAIL[$i]}")"
  done
  printf ']}\n'
else
  printf '\n%-6s %-28s %s\n' "STATUS" "CHECK" "DETAIL"
  printf '%-6s %-28s %s\n' "------" "----------------------------" "------"
  for i in "${!CHECK_NAMES[@]}"; do
    printf '%-6s %-28s %s\n' "${CHECK_STATUS[$i]}" "${CHECK_NAMES[$i]}" "${CHECK_DETAIL[$i]}"
  done
  printf '\n%d checks, %d failed\n' "${#CHECK_NAMES[@]}" "$failed"
fi

if [ "$failed" -gt 0 ]; then
  exit 1
fi
exit 0
