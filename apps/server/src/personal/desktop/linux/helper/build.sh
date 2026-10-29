#!/usr/bin/env bash
# Build pbdesk-wl by hand, for a quick local check. The server builds its own
# copy from the embedded sources (helperSource.ts), so this script only writes
# into a temp dir and never into the repository.
# Needs: gcc, wayland-scanner, wayland-client and libxkbcommon.
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)"
out="$(mktemp -d /tmp/pbdesk-build-XXXXXX)"
trap 'rm -rf "$out"' EXIT
cp "$src/pbdesk-wl.c" "$src/wlr-virtual-pointer-unstable-v1.xml" \
  "$src/virtual-keyboard-unstable-v1.xml" "$out/"
cd "$out"
wayland-scanner client-header wlr-virtual-pointer-unstable-v1.xml wlr-virtual-pointer-unstable-v1.h
wayland-scanner private-code wlr-virtual-pointer-unstable-v1.xml wlr-virtual-pointer-unstable-v1.c
wayland-scanner client-header virtual-keyboard-unstable-v1.xml virtual-keyboard-unstable-v1.h
wayland-scanner private-code virtual-keyboard-unstable-v1.xml virtual-keyboard-unstable-v1.c
gcc -O2 -Wall -Wextra -o "$out/pbdesk-wl" pbdesk-wl.c wlr-virtual-pointer-unstable-v1.c \
  virtual-keyboard-unstable-v1.c $(pkg-config --cflags --libs wayland-client xkbcommon)
echo "built $out/pbdesk-wl"
