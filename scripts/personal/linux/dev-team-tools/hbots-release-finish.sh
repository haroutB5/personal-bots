#!/usr/bin/env bash
# hbots post-release finisher (one script for every release; replaces the per-release
# qa/<task>/ship/finish.sh copies). Opuser starts it in the ship task, detached, with
# --launch (a systemd --user unit whose name does not begin with hbots-release).
#
# What a real run does, in order:
#   1. waits until ~/.personal-bots/run/restart-<ver>-result.json says live_verified and no
#      hbots-release*<ver>* unit is still running (or the runner rolled back / failed);
#   2. on rollback or failure: publishes nothing, merges nothing, writes LIVE-RECORD.md, exits;
#   3. on live_verified: checks the APK sha256, checks that $JAVA_HOME/bin/java runs (JAVA_HOME
#      is fixed to the mise temurin-21 install, never derived from PATH: under systemd-run
#      `command -v java` gave /usr and apkanalyzer failed in 1.67.47), runs
#      apps/hbots-mobile/scripts/publish-android-update.mjs from the release worktree;
#   4. fast-forwards the main checkout's trunk branch to --main-sha (--ff-only) and pushes it,
#      never forced;
#   5. removes the release worktree (git worktree remove, never --force) only when both the
#      publish and the push worked; a fixed release slot is kept instead, and its lease is
#      released (tools/hbots-slot.sh release) under the same condition;
#   6. writes <qa-dir>/LIVE-RECORD.md and adds the version line to apps/hbots-android.md;
#   7. runs tools/hbots-release-livecheck.sh 5 minutes after live (<qa-dir>/LIVE-CHECKS.md).
#
# Tiered gates (Faster releases step 2, Nov 2026): when the release's gate-evidence.json is the
# "blocking" tier, step 3 first runs tools/hbots-async-gates.mjs (the deferred checks, from the
# release worktree). Only a pass goes on to publish, push and remove the worktree. A failure
# that rolled the server back, or that kept it live (a newer release behind it, a migration),
# publishes nothing and pushes nothing, so no phone gets an APK the live server was not proven
# with; the async tool has already posted the notice. --no-async skips it (for a re-run).
#
# Server-only track (Faster releases step 3): --server-only replaces --apk, --apk-sha256 and
# --notes for a release that changes nothing the phone app is built from (releaseTrack in the
# release's gateScope.mjs decides; --check refuses --server-only when it says "full"). It
# publishes no latest.json and adds no apps/hbots-android.md line; trunk, the worktree,
# LIVE-RECORD.md and the livecheck work as for a full release.
#
# --check resolves and tests everything a real run needs (java, apkanalyzer on the APK, sha,
# worktree, trunk, node) and changes nothing. Run it under the same conditions as the real
# run:  systemd-run --user --wait --pipe --collect bash <this> --check <args>
set -uo pipefail

# The HBOTS_FINISH_* overrides exist for the tests (tools.test.mjs); a real release sets none.
TOOLS=${HBOTS_FINISH_TOOLS:-/home/harout/Claude/AI/dev-team/tools}
DEVTEAM=/home/harout/Claude/AI/dev-team
JAVA_HOME_FIXED=/home/harout/.local/share/mise/installs/java/temurin-21
ANDROID_HOME_FIXED=/home/harout/Android/Sdk
NODE_DEFAULT=/home/harout/.local/share/mise/installs/node/24.22.3/bin/node
REPO_DEFAULT=/home/harout/Claude/AI/personal-bots
OUT_DEFAULT=/home/harout/.personal-bots/dev
RUN_DIR=${HBOTS_FINISH_RUN_DIR:-/home/harout/.personal-bots/run}
LOG_DIR=${HBOTS_FINISH_LOG_DIR:-/home/harout/.personal-bots/logs}
LIVE_URL=${HBOTS_FINISH_URL:-http://127.0.0.1:38472}
# Release slots (tools/hbots-slot.sh reads the same two variables).
SLOT_ROOT=${HBOTS_SLOT_ROOT:-/home/harout/Claude/AI/_wt}
SLOT_STATE=${HBOTS_SLOT_STATE:-/home/harout/.personal-bots/run/hbots-slots}
ANDROID_SHEET=$DEVTEAM/apps/hbots-android.md

usage() {
  cat <<'EOF'
Usage: hbots-release-finish.sh (--check | --launch | --run) \
  --version X.Y.Z --release <sha12|sha40> --main-sha <sha40> \
  --apk <signed release apk> --apk-sha256 <64 hex> --notes "<latest.json notes>" \
  (or instead of --notes: --note "<line>" repeated, one per What's new line) \
  (or instead of all three: --server-only, for a release with no phone app change) \
  --worktree <release worktree> --qa-dir <dev-team/qa/<task8>/ship> \
  [--android-text "<what changed on the phone, for apps/hbots-android.md>"] \
  [--repo <main checkout, default /home/harout/Claude/AI/personal-bots>] \
  [--trunk <branch, default personal-bots/main>] [--out <data root, default ~/.personal-bots/dev>] \
  [--node <node binary>] [--java-home <dir, default mise temurin-21>] \
  [--timeout-sec <wait for the runner, default 14400>] [--no-livecheck] [--no-async] \
  [--emulator-apk <x86_64 QA apk: run the emulator flows the release deferred, before publishing>] \
  [--slot-label <lease label; default the label holding the slot when the run starts>]

  --check   test java, apkanalyzer on the APK, sha, worktree, trunk and node; change nothing.
  --launch  run --check, then start the real run as systemd --user unit
            finish-hbots-<version without dots> and record the unit in <qa-dir>/finish.unit.
  --run     the real run in the current process (what --launch starts).
Exit codes: 0 done (or rolled back cleanly), 1 a step failed, 2 bad arguments, 3 java broken.
EOF
}

MODE=; VERSION=; RELEASE=; MAIN_SHA=; APK=; APK_SHA=; NOTES=; WT=; QA=; ANDROID_TEXT=; SLOT_LABEL=; EMU_APK=
REPO=$REPO_DEFAULT; TRUNK=personal-bots/main; OUT=$OUT_DEFAULT; N=$NODE_DEFAULT
JAVA_HOME_ARG=$JAVA_HOME_FIXED; TIMEOUT=14400; LIVECHECK=yes; ASYNC=yes; TRACK=full
ORIG_ARGS=("$@")
while (( $# )); do
  case $1 in
    --check|--launch|--run) [[ -z $MODE ]] || { echo "only one of --check/--launch/--run" >&2; exit 2; }; MODE=${1#--};;
    --version) VERSION=${2-}; shift;;
    --release) RELEASE=${2-}; shift;;
    --main-sha) MAIN_SHA=${2-}; shift;;
    --apk) APK=${2-}; shift;;
    --apk-sha256) APK_SHA=${2-}; shift;;
    --notes) NOTES=${2-}; shift;;
    --note) NOTES+=${NOTES:+$'\n'}${2-}; shift;;
    --worktree) WT=${2-}; shift;;
    --qa-dir) QA=${2-}; shift;;
    --android-text) ANDROID_TEXT=${2-}; shift;;
    --repo) REPO=${2-}; shift;;
    --trunk) TRUNK=${2-}; shift;;
    --out) OUT=${2-}; shift;;
    --node) N=${2-}; shift;;
    --java-home) JAVA_HOME_ARG=${2-}; shift;;
    --timeout-sec) TIMEOUT=${2-}; shift;;
    --no-livecheck) LIVECHECK=no;;
    --no-async) ASYNC=no;;
    --server-only) TRACK=server-only;;
    --slot-label) SLOT_LABEL=${2-}; shift;;
    --emulator-apk) EMU_APK=${2-}; shift;;
    -h|--help) usage; exit 0;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2;;
  esac
  shift
done

# ---- argument validation (all modes) ----
bad=0
argfail() { echo "bad argument: $*" >&2; bad=1; }
[[ -n $MODE ]] || argfail "one of --check, --launch or --run is required"
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || argfail "--version must be X.Y.Z (got '$VERSION')"
[[ $RELEASE =~ ^[0-9a-f]{12}([0-9a-f]{28})?$ ]] || argfail "--release must be a 12 or 40 char sha (got '$RELEASE')"
[[ $MAIN_SHA =~ ^[0-9a-f]{40}$ ]] || argfail "--main-sha must be a full 40 char sha (got '$MAIN_SHA')"
if [[ $TRACK == full ]]; then
  [[ $APK_SHA =~ ^[0-9a-f]{64}$ ]] || argfail "--apk-sha256 must be 64 lowercase hex chars"
  [[ -n ${NOTES// /} ]] || argfail "--notes must not be empty"
  [[ -n $APK && -f $APK ]] || argfail "--apk file not found: '$APK'"
else
  [[ -z $APK && -z $APK_SHA && -z $NOTES && -z $EMU_APK ]] || argfail "--server-only takes no --apk, --apk-sha256, --notes or --emulator-apk"
fi
[[ -n $WT ]] || argfail "--worktree is required"
[[ -n $QA && -d $QA ]] || argfail "--qa-dir must be an existing folder: '$QA'"
[[ $TIMEOUT =~ ^[0-9]+$ ]] || argfail "--timeout-sec must be a number"
(( bad )) && { usage >&2; exit 2; }
[[ -z $EMU_APK || -f $EMU_APK ]] || { argfail "--emulator-apk file not found: '$EMU_APK'"; usage >&2; exit 2; }
[[ -n $APK ]] && APK=$(readlink -f "$APK"); QA=$(readlink -f "$QA")
[[ -n $EMU_APK ]] && EMU_APK=$(readlink -f "$EMU_APK")
[[ -d $WT ]] && WT=$(readlink -f "$WT")
REPO=$(readlink -f "$REPO")
IFS=. read -r V1 V2 V3 <<<"$VERSION"
VERSION_CODE=$(( V1 * 1000000 + V2 * 1000 + V3 ))
VNODOT=${VERSION//./}
UNIT=finish-hbots-$VNODOT
RES=$RUN_DIR/restart-$VERSION-result.json
# The slot number when --worktree is a fixed release slot (step 5), else empty.
SLOT_N=
[[ $(realpath -m -- "$WT") =~ ^$(realpath -m -- "$SLOT_ROOT")/hbots-slot-([12])$ ]] && SLOT_N=${BASH_REMATCH[1]}
slot_holder() { sed -n 's/^label=//p' "$SLOT_STATE/slot-$SLOT_N.lease" 2>/dev/null | head -n 1; }
RLOG=$LOG_DIR/restart-$VERSION.log

# ---- fixed environment: never derived from PATH ----
export JAVA_HOME=$JAVA_HOME_ARG
export ANDROID_HOME=$ANDROID_HOME_FIXED
export ANDROID_SDK_ROOT=$ANDROID_HOME_FIXED
export PATH="$JAVA_HOME/bin:$(dirname "$N"):/home/harout/.local/share/mise/shims:${PATH:-/usr/bin:/bin}"
APKANALYZER=$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer

java_ok() {
  # Prints the java version line; returns non-zero with a loud message when java does not run.
  local v
  if [[ ! -x $JAVA_HOME/bin/java ]]; then
    echo "FATAL: JAVA_HOME=$JAVA_HOME has no executable bin/java. latest.json will NOT be published. Fix the java install (mise install java@temurin-21) or pass --java-home." >&2
    return 3
  fi
  if ! v=$("$JAVA_HOME/bin/java" -version 2>&1); then
    echo "FATAL: $JAVA_HOME/bin/java -version failed: $v. latest.json will NOT be published." >&2
    return 3
  fi
  echo "${v%%$'\n'*}"
}

# ---- check mode: test everything, change nothing ----
run_check() {
  local fails=0 line got
  ok()   { echo "OK    $*"; }
  warn() { echo "WARN  $*"; }
  fail() { echo "FAIL  $*"; fails=$((fails+1)); }
  echo "hbots-release-finish check $(date -u +%FT%TZ) version=$VERSION (versionCode $VERSION_CODE) user=$(id -un) systemd=${INVOCATION_ID:-no}"
  echo "JAVA_HOME=$JAVA_HOME (resolves to $(readlink -f "$JAVA_HOME"))"
  echo "ANDROID_HOME=$ANDROID_HOME"
  if [[ $TRACK == server-only ]]; then
    # The release's own planner must agree that the phone app did not change.
    live=$(tr -d '[:space:]' < "$HOME/.personal-bots/releases/current.txt" 2>/dev/null)
    verdict=$("$N" --input-type=module -e '
      const [wt,base,head]=process.argv.slice(1);
      const m=await import(wt+"/scripts/personal/linux/hbots-release/lib/gateScope.mjs");
      const s=await import(wt+"/scripts/personal/linux/hbots-release/lib/serverTestSelect.mjs");
      const {execFileSync}=await import("node:child_process");
      const changed=execFileSync("git",["-C",wt,"diff","--no-renames","--name-only",base,head],{encoding:"utf8"}).split("\n").filter(Boolean);
      const t=m.releaseTrack({changedPaths:changed,reader:s.gitReader(wt,head),baseReader:s.gitReader(wt,base)});
      console.log(t.track+" "+t.reason);' "$WT" "$live" "$RELEASE" 2>&1 | tail -1)
    if [[ $verdict == server-only* ]]; then ok "release track: $verdict"; else fail "--server-only, but the release track is: $verdict"; fi
  else
  if line=$(java_ok 2>&1); then ok "java runs: $line"; else fail "$line"; fi
  if [[ -x $APKANALYZER ]]; then
    got=$("$APKANALYZER" manifest version-name "$APK" 2>&1 | tail -1)
    if [[ $got == "$VERSION" ]]; then ok "apkanalyzer manifest version-name = $got"; else fail "apkanalyzer version-name gave '$got', expected $VERSION"; fi
    got=$("$APKANALYZER" manifest version-code "$APK" 2>&1 | tail -1)
    if [[ $got == "$VERSION_CODE" ]]; then ok "apkanalyzer manifest version-code = $got"; else fail "apkanalyzer version-code gave '$got', expected $VERSION_CODE"; fi
  else
    fail "apkanalyzer not found at $APKANALYZER"
  fi
  got=$(sha256sum "$APK" | cut -c1-64)
  if [[ $got == "$APK_SHA" ]]; then ok "APK sha256 matches ($(stat -c %s "$APK") bytes)"; else fail "APK sha256 is $got, expected $APK_SHA"; fi
  fi
  if "$N" --version >/dev/null 2>&1; then ok "node $("$N" --version) at $N"; else fail "node does not run: $N"; fi
  if [[ -d $WT ]] && git -C "$WT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [[ $(git -C "$WT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) == "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" ]]; then
      ok "worktree $WT belongs to $REPO (branch $(git -C "$WT" rev-parse --abbrev-ref HEAD))"
    else
      fail "worktree $WT is not a worktree of $REPO"
    fi
    if [[ $WT == "$REPO" ]]; then warn "--worktree is the main checkout; a real run refuses this (it would remove it)"; fi
    [[ $TRACK == server-only || -f $WT/apps/hbots-mobile/scripts/publish-android-update.mjs ]] && ok "publish-android-update.mjs present in worktree" || fail "no apps/hbots-mobile/scripts/publish-android-update.mjs in $WT"
    got=$(tr -d '[:space:]' < "$WT/scripts/personal/app-version.txt" 2>/dev/null)
    [[ $got == "$VERSION" ]] && ok "worktree app-version.txt = $got" || fail "worktree app-version.txt is '$got', expected $VERSION"
  else
    fail "worktree $WT does not exist or is not a git work tree"
  fi
  if git -C "$REPO" cat-file -e "$RELEASE^{commit}" 2>/dev/null; then ok "release $RELEASE = $(git -C "$REPO" rev-parse "$RELEASE^{commit}")"; else fail "release sha $RELEASE not found in $REPO"; fi
  if git -C "$REPO" cat-file -e "$MAIN_SHA^{commit}" 2>/dev/null; then
    ok "main sha $MAIN_SHA exists"
    got=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)
    [[ $got == "$TRUNK" ]] && ok "main checkout is on $TRUNK" || fail "main checkout $REPO is on '$got', expected $TRUNK"
    if git -C "$REPO" merge-base --is-ancestor HEAD "$MAIN_SHA"; then ok "trunk HEAD $(git -C "$REPO" rev-parse --short HEAD) can fast-forward to main sha (or already equals it)"; else fail "trunk HEAD is not an ancestor of $MAIN_SHA: a fast-forward is impossible"; fi
  else
    fail "main sha $MAIN_SHA not found in $REPO (fetch first)"
  fi
  [[ -d $OUT ]] && ok "data root $OUT exists" || fail "data root $OUT missing"
  [[ -w $QA ]] && ok "qa dir $QA writable" || fail "qa dir $QA not writable"
  [[ -f $ANDROID_SHEET ]] && ok "android sheet $ANDROID_SHEET present" || fail "android sheet $ANDROID_SHEET missing"
  [[ -x $TOOLS/hbots-release-livecheck.sh ]] && ok "livecheck tool present" || fail "$TOOLS/hbots-release-livecheck.sh missing or not executable"
  [[ -f $TOOLS/hbots-async-gates.mjs ]] && ok "async gate tool present" || fail "$TOOLS/hbots-async-gates.mjs missing"
  if [[ -n $EMU_APK ]]; then
    sk=$WT/apps/hbots-mobile/.claude/skills/verify-hbots-android/scripts
    [[ -f $sk/verify.sh && -f $sk/select-flows.mjs ]] && ok "emulator flows after live: $(basename "$EMU_APK") with $sk/verify.sh --tier async" || fail "--emulator-apk given but $sk has no verify.sh or select-flows.mjs"
  fi
  if [[ -f $RES ]]; then
    ok "runner result already exists: status $("$N" -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).status)}catch{console.log("unreadable")}' "$RES")"
  else
    ok "runner result $RES not written yet (expected before the release lands)"
  fi
  if [[ -n $SLOT_N ]]; then
    holder=$(slot_holder)
    if [[ -z $holder ]]; then
      warn "slot $SLOT_N is not leased: no lease to release after the push"
    elif [[ -n $SLOT_LABEL && $holder != "$SLOT_LABEL" ]]; then
      fail "slot $SLOT_N is leased by '$holder', not --slot-label '$SLOT_LABEL'"
    else
      ok "slot $SLOT_N leased by '$holder': released after a publish (or server-only) and a trunk push"
    fi
  fi
  if systemctl --user is-active --quiet "$UNIT.service" 2>/dev/null; then fail "unit $UNIT.service is already running"; else ok "unit name $UNIT.service is free"; fi
  echo "check result: $([[ $fails == 0 ]] && echo PASS || echo "FAIL ($fails)")"
  return $(( fails > 0 ))
}

if [[ $MODE == check ]]; then
  run_check; exit $?
fi

if [[ $MODE == launch ]]; then
  if ! run_check; then echo "refusing to launch: check failed" >&2; exit 1; fi
  if [[ $WT == "$REPO" ]]; then echo "refusing to launch: --worktree is the main checkout" >&2; exit 2; fi
  args=()
  for a in "${ORIG_ARGS[@]}"; do [[ $a == --launch ]] && args+=(--run) || args+=("$a"); done
  systemd-run --user --unit="$UNIT" --collect --description="hbots $VERSION post-release finisher" \
    --working-directory="$QA" /usr/bin/bash "$(readlink -f "$0")" "${args[@]}" || { echo "systemd-run failed" >&2; exit 1; }
  echo "$UNIT.service started $(date -u +%FT%TZ)" > "$QA/finish.unit"
  echo "launched $UNIT.service; log $QA/finish.log; unit recorded in $QA/finish.unit"
  exit 0
fi

# ---- real run ----
if [[ $WT == "$REPO" ]]; then echo "refusing: --worktree is the main checkout" >&2; exit 2; fi
exec >>"$QA/finish.log" 2>&1
echo "finisher start $(date -u +%FT%TZ) version=$VERSION release=$RELEASE main=$MAIN_SHA JAVA_HOME=$JAVA_HOME"
if [[ $TRACK == full ]]; then
  if ! jline=$(java_ok); then
    echo "finisher abort $(date -u +%FT%TZ): java broken before the wait (see FATAL above)"; exit 3
  fi
  echo "java ok: $jline"
else
  echo "server-only track: no APK, no latest.json"
fi

field() {
  "$N" -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=r[process.argv[2]];console.log(v===undefined?"undefined":JSON.stringify(v))}catch(e){console.log("unreadable")}' "$RES" "$1"
}

REL40=$(git -C "$REPO" rev-parse "$RELEASE^{commit}" 2>/dev/null || echo "$RELEASE")
REL12=${REL40:0:12}
BRANCH=$(git -C "$WT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
APK_BYTES=$([[ -n $APK ]] && stat -c %s "$APK" || echo 0)
CERT=$(tr -d '[:space:]' < "$WT/apps/hbots-mobile/release-cert.sha256" 2>/dev/null || echo unknown)
# The lease this run releases at the end: the given label, else whoever holds the slot now.
[[ -n $SLOT_N && -z $SLOT_LABEL ]] && SLOT_LABEL=$(slot_holder)
[[ -n $SLOT_N ]] && echo "release slot $SLOT_N, lease label '${SLOT_LABEL:-none}'"

rc=0
deadline=$(( $(date +%s) + TIMEOUT ))
status=none; active=?
while (( $(date +%s) < deadline )); do
  status=$(field status | tr -d '"')
  active=$(systemctl --user list-units --no-pager --plain --no-legend "hbots-release*$VERSION*" 2>/dev/null | grep -c running || true)
  if [[ $status == live_verified && $active == 0 ]]; then break; fi
  if [[ $status == rolled_back || $status == rollback_failed || $status == failed ]]; then break; fi
  sleep 10
done
echo "runner status=$status active=$active $(date -u +%FT%TZ)"
cp "$RES" "$QA/restart-$VERSION-result.json" 2>/dev/null || true
cp "$RLOG" "$QA/restart-$VERSION.log" 2>/dev/null || true
ROLLBACK=$(field rollback | tr -d '"')

# ---- async tier: the checks the blocking evidence deferred, before anything is published ----
asyncgates=none
EVID=$HOME/.personal-bots/releases/$REL12/gate-evidence.json
tier=$("$N" -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tier??"full")}catch{console.log("unreadable")}' "$EVID")
# The emulator flows the release deferred (--emulator-apk) run here too, whatever the gate tier.
if [[ $status == live_verified && ( $tier == blocking || -n $EMU_APK ) ]]; then
  if [[ $ASYNC == no ]]; then
    asyncgates=skipped; echo "async tier skipped (--no-async)"
  else
    echo "async tier start $(date -u +%FT%TZ)"
    "$N" "$TOOLS/hbots-async-gates.mjs" --version "$VERSION" --release "$REL12" --worktree "$WT" --qa-dir "$QA" ${EMU_APK:+--emulator-apk "$EMU_APK"}
    arc=$?
    case $arc in
      0) asyncgates=passed;;
      10) asyncgates=rolled_back; status=async_rolled_back;;
      12) asyncgates=rollback_failed; status=async_rollback_failed; rc=1;;
      *) asyncgates="failed (exit $arc)"; status=async_failed;;
    esac
    echo "async tier end $(date -u +%FT%TZ): $asyncgates"
  fi
fi

published=no; ffmain=no; wtremoved=no; compat=unchecked; rc=${rc:-0}
versiontxt=$(curl -s --max-time 5 "$LIVE_URL/version.txt" | head -4 | tr '\n' ' ')
if [[ $status == live_verified ]]; then
  got=$([[ -n $APK ]] && sha256sum "$APK" | cut -c1-64)
  if [[ $TRACK == server-only ]]; then
    published=skipped; echo "server-only track: latest.json not republished"
  elif [[ $got != "$APK_SHA" ]]; then
    echo "FATAL: APK sha mismatch: $got (expected $APK_SHA); latest.json NOT published"; rc=1
  elif ! jline=$(java_ok); then
    echo "FATAL: java broke during the wait; latest.json NOT published"; rc=3
  else
    echo "publishing with JAVA_HOME=$JAVA_HOME ($jline)"
    if (cd "$WT" && "$N" apps/hbots-mobile/scripts/publish-android-update.mjs "$APK" --out "$OUT" --notes "$NOTES"); then
      published=yes; date -u +%FT%TZ > "$QA/published.at"
    else
      echo "FATAL: publish-android-update.mjs failed (exit $?); latest.json NOT published"; rc=1
    fi
  fi
  compat=$(curl -s --max-time 5 "$LIVE_URL/api/personal/client-compat" | head -c 500)

  # Fast-forward trunk (never force)
  cur=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)
  if [[ $cur != "$TRUNK" ]]; then
    echo "FATAL: main checkout is on '$cur', not $TRUNK; trunk not fast-forwarded"; rc=1
  elif git -C "$REPO" fetch -q origin && git -C "$REPO" merge-base --is-ancestor HEAD "$MAIN_SHA" \
    && git -C "$REPO" -c user.email=harout_b5@live.com -c user.name=haroutB5 merge --ff-only "$MAIN_SHA" \
    && git -C "$REPO" push origin "$TRUNK"; then
    ffmain=yes
  else
    echo "FATAL: fast-forward or push of $TRUNK to $MAIN_SHA failed"; rc=1
  fi

  if [[ -n $SLOT_N ]]; then
    # A fixed release slot (step 5) is never removed: its .env and build caches stay for the
    # next release. Once the release is published (or server-only) and trunk is pushed, the
    # slot's work is done, so the finisher releases the lease itself.
    wtremoved=slot
    if [[ $ffmain == yes && ( $published == yes || $published == skipped ) ]]; then
      if [[ -z $SLOT_LABEL ]]; then
        echo "worktree kept: $WT is release slot $SLOT_N; it was not leased, nothing to release"
      elif out=$(bash "$TOOLS/hbots-slot.sh" release --slot "$SLOT_N" --label "$SLOT_LABEL" 2>&1); then
        echo "worktree kept: $WT is release slot $SLOT_N; lease '$SLOT_LABEL' released ($out)"
        wtremoved="slot (lease released)"
      else
        echo "worktree kept: $WT is release slot $SLOT_N; lease release failed: $out"
        wtremoved="slot (lease release failed)"
      fi
    else
      echo "worktree kept: $WT is release slot $SLOT_N; lease '$SLOT_LABEL' kept: published=$published ffmain=$ffmain"
      wtremoved="slot (lease kept)"
    fi
  elif [[ $ffmain == yes && ( $published == yes || $published == skipped ) ]]; then
    rm -f "$WT/.env"
    # Allowed leftover of the release-tools check (handbook: release worktrees and Python caches).
    rm -f "$WT/scripts/personal/linux/dev-team-tools/__pycache__/ab.cpython-314.pyc"
    rmdir "$WT/scripts/personal/linux/dev-team-tools/__pycache__" 2>/dev/null || true
    if git -C "$REPO" worktree remove "$WT" && git -C "$REPO" worktree prune; then wtremoved=yes
    else echo "worktree remove refused (left in place; never --force)"; rc=1; fi
  else
    echo "worktree kept: published=$published ffmain=$ffmain"
  fi
fi

LATEST=$(cat "$OUT/android-updates/latest.json" 2>/dev/null || true)
QA_REL=${QA#"$DEVTEAM"/}
APK_REL=${APK#"$DEVTEAM"/}
{
  echo "# hbots $VERSION Live Record"
  echo
  echo "- **Date:** $(date -u +%Y-%m-%d)"
  echo "- **Version:** \`$VERSION\` (Android \`versionCode $VERSION_CODE\`)"
  echo "- **Server release SHA:** \`$REL12\` (full \`$REL40\`, \`$BRANCH\`)"
  echo "- **Trunk commit (\`$TRUNK\`):** \`$MAIN_SHA\` (fast-forward pushed: $ffmain)"
  echo "- **Rollback target:** \`$ROLLBACK\`"
  echo "- **Outcome:** \`$status\` (smokeExit=$(field smokeExit), restartExit=$(field restartExit), logErrors=$(field logErrors), logWarnings=$(field logWarnings))"
  echo "- **Timeline:** armedAt=$(field armedAt), idleAt=$(field idleAt), activatedAt=$(field activatedAt), verifiedAt=$(field verifiedAt)"
  echo "- **version.txt:** \`$versiontxt\`"
  if [[ $TRACK == server-only ]]; then
    echo "- **Track:** server-only (no APK built, no emulator QA, latest.json unchanged)"
  else
    echo "- **APK:** sha256 \`$APK_SHA\`, \`$APK_BYTES\` bytes, signer pin \`$CERT\` (\`release-cert.sha256\`; publish refuses any other signer)"
  fi
  echo "- **JAVA_HOME:** \`$JAVA_HOME\`"
  echo "- **latest.json published:** $published at $(cat "$QA/published.at" 2>/dev/null || echo n/a)"
  echo "- **client-compat:** \`$compat\`"
  echo "- **Worktree removed:** $wtremoved"
  echo "- **Gate tier:** \`$tier\`; async gates: $asyncgates$([[ -f $QA/ASYNC-RECORD.md ]] && echo " (\`$QA_REL/ASYNC-RECORD.md\`)")"
  echo "- **Finisher:** \`tools/hbots-release-finish.sh\`, log \`$QA_REL/finish.log\`"
  echo
  echo '```json'
  echo "$LATEST"
  echo '```'
  # The gate timing waterfall (Faster releases step 1): every handoff and LIVE-RECORD shows it.
  for wf in "$HOME/.personal-bots/releases/$REL12/gate-evidence-logs/waterfall.txt" "$QA/async-releases/$REL12/gate-evidence-async-logs/waterfall.txt"; do
    [[ -f $wf ]] || continue
    echo
    [[ $wf == *async* ]] && echo "## Gate timing (async tier)" || echo "## Gate timing"
    echo
    echo '```'
    cat "$wf"
    echo '```'
  done
} > "$QA/LIVE-RECORD.md"

if [[ $status == live_verified && $published == yes ]]; then
  F_VERSION=$VERSION F_CODE=$VERSION_CODE F_REL12=$REL12 F_REL40=$REL40 F_BRANCH=$BRANCH F_MAIN=$MAIN_SHA \
  F_SHA=$APK_SHA F_BYTES=$APK_BYTES F_CERT=$CERT F_TEXT="${ANDROID_TEXT:-Notes: $NOTES}" F_APK_REL=$APK_REL \
  F_ROLLBACK=$ROLLBACK F_QA_REL=$QA_REL F_SHEET=$ANDROID_SHEET python3 -I - <<'PY' || { echo "hbots-android.md update failed"; rc=1; }
import os, re, datetime
e = os.environ
p = e['F_SHEET']
t = open(p, encoding='utf-8', newline='').read()
nl = '\r\n' if '\r\n' in t else '\n'
if f"- **{e['F_VERSION']}** (" in t:
    print('hbots-android.md already has the line')
else:
    day = datetime.date.today()
    line = (f"- **{e['F_VERSION']}** ({day.day} {day.strftime('%b %Y')}): versionCode {e['F_CODE']}, release sha `{e['F_REL12']}` "
            f"(full `{e['F_REL40']}` on {e['F_BRANCH']}), main commit `{e['F_MAIN']}`, sha256 `{e['F_SHA']}`, {e['F_BYTES']} bytes, "
            f"signer equals `release-cert.sha256` (`{e['F_CERT']}`). {e['F_TEXT']} "
            f"Build copy `dev-team/{e['F_APK_REL']}`, served copy `~/.personal-bots/dev/android-updates/hbots-{e['F_VERSION']}.apk`. "
            f"Server rollback target `{e['F_ROLLBACK']}`. Record `{e['F_QA_REL']}/LIVE-RECORD.md`. Finisher `tools/hbots-release-finish.sh`.")
    m = re.search(r'^- \*\*\d+\.\d+\.\d+\*\* \(', t, re.M)
    if not m:
        raise SystemExit('no version line found to insert before')
    t = t[:m.start()] + line + nl + t[m.start():]
    open(p, 'w', encoding='utf-8', newline='').write(t)
    print('hbots-android.md line added')
PY
fi
echo "finisher done $(date -u +%FT%TZ) status=$status published=$published ffmain=$ffmain wtremoved=$wtremoved rc=$rc"

if [[ $status == live_verified && $LIVECHECK == yes ]]; then
  bash "$TOOLS/hbots-release-livecheck.sh" --version "$VERSION" --qa-dir "$QA" --worktree "$WT" --delay-sec 300 \
    || echo "livecheck failed (exit $?)"
fi
exit $rc
