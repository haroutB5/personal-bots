#!/usr/bin/env bash
# Build the Linux desktop helper. Needs: gcc, wayland, wayland-protocols (scanner), libxkbcommon.
set -euo pipefail
cd "$(dirname "$0")"
wayland-scanner client-header wlr-virtual-pointer-unstable-v1.xml wlr-virtual-pointer-unstable-v1.h
wayland-scanner private-code wlr-virtual-pointer-unstable-v1.xml wlr-virtual-pointer-unstable-v1.c
wayland-scanner client-header virtual-keyboard-unstable-v1.xml virtual-keyboard-unstable-v1.h
wayland-scanner private-code virtual-keyboard-unstable-v1.xml virtual-keyboard-unstable-v1.c
gcc -O2 -Wall -Wextra -o pbdesk-wl pbdesk-wl.c wlr-virtual-pointer-unstable-v1.c \
  virtual-keyboard-unstable-v1.c $(pkg-config --cflags --libs wayland-client xkbcommon)
echo "built $(pwd)/pbdesk-wl"
