#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 && -f "$1/scripts/personal/node/hbots.mjs" ]] || { echo 'Usage: build.sh REPO (stages copied externals, never activates)' >&2; exit 2; }
here=$(dirname -- "$(readlink -f -- "$0")")
repo=$(realpath -- "$1")
exec bash "$here/heavy-job.sh" --label "hbots stage $repo" --work-dir "$repo" -- node scripts/personal/node/hbots.mjs build --copy-externals
