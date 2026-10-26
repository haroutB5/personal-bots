#!/usr/bin/env bash
# Installs the reviewed runner next to the other run/ files and pins its helpers (PINS.json).
# Usage: bash install.sh [--dest DIR]      default DEST: ~/.personal-bots/run/hbots-release-linux
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
dest=/home/harout/.personal-bots/run/hbots-release-linux
node=/home/harout/.local/share/mise/installs/node/24.22.1/bin/node
while (($#)); do
  case "$1" in
    --dest) dest=${2:?}; shift 2;;
    *) echo 'Usage: install.sh [--dest DIR]' >&2; exit 2;;
  esac
done
[[ -x $node ]] || { echo "pinned node missing: $node" >&2; exit 1; }
"$node" --check "$here/hbots-release.mjs" "$here/hbots-release-launch.mjs"
mkdir -p "$dest/lib"
cp -f "$here"/hbots-release.mjs "$here"/hbots-release-launch.mjs "$dest/"
cp -f "$here"/lib/*.mjs "$dest/lib/"
chmod 0644 "$dest"/*.mjs "$dest"/lib/*.mjs
rm -f "$dest/PINS.json"
"$node" "$dest/hbots-release.mjs" --write-pins
echo "installed to $dest"
echo "launcher: $node $dest/hbots-release-launch.mjs ..."
