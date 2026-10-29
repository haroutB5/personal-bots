#!/usr/bin/env bash
# Installs the reviewed runner and the helpers it pins as one set, so a helper
# that was fixed in the repo can never be replaced by an older copy at install
# time. Every file is written to a sibling temp file and renamed into place.
# Usage: bash install.sh [--dest DIR] [--tools-dest DIR] [--tools-src DIR]
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
dest=/home/harout/.personal-bots/run/hbots-release-linux
tools_dest=/home/harout/Claude/AI/dev-team/tools
tools_src=$here/../dev-team-tools
node=/home/harout/.local/share/mise/installs/node/24.22.1/bin/node
while (($#)); do
  case "$1" in
    --dest) dest=${2:?}; shift 2;;
    --tools-dest) tools_dest=${2:?}; shift 2;;
    --tools-src) tools_src=${2:?}; shift 2;;
    *) echo 'Usage: install.sh [--dest DIR] [--tools-dest DIR] [--tools-src DIR]' >&2; exit 2;;
  esac
done
[[ -x $node ]] || { echo "pinned node missing: $node" >&2; exit 1; }
"$node" --check "$here/hbots-release.mjs" "$here/hbots-release-launch.mjs"
mkdir -p "$dest/lib" "$tools_dest"

# Atomic replace: write beside the target (same filesystem), then rename.
install_file() {
  local src=$1 target=$2 tmp
  tmp=$(mktemp "$target.XXXXXX")
  cp -f "$src" "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$target"
}

for file in hbots-release.mjs hbots-release-launch.mjs; do
  install_file "$here/$file" "$dest/$file"
done
for file in "$here"/lib/*.mjs; do
  install_file "$file" "$dest/lib/$(basename -- "$file")"
done

# The pinned helper tools the runner imports or executes (PINS.json) plus the
# shared heavy-job lock wrapper. They come from the same reviewed tree as the
# runner, so installing cannot restore a helper the repo already fixed.
tools=(check-release-notes.mjs check-gate-evidence.mjs gate-common.mjs ops-common.mjs notify-release.mjs heavy-job.sh)
for file in "${tools[@]}"; do
  [[ -f "$tools_src/$file" ]] || { echo "missing tool source: $tools_src/$file" >&2; exit 1; }
  install_file "$tools_src/$file" "$tools_dest/$file"
done

rm -f "$dest/PINS.json"
# Pins describe the files just installed, so point the hasher at that folder
# (the runner otherwise reads its default tools dir).
HBOTS_RELEASE_TEST=1 HBOTS_RELEASE_TEST_TOOLS="$tools_dest" "$node" "$dest/hbots-release.mjs" --write-pins
echo "installed to $dest"
echo "helper tools installed to $tools_dest (${#tools[@]} files)"
echo "launcher: $node $dest/hbots-release-launch.mjs ..."
