#!/usr/bin/env bash
#
# enable-ssh.sh - get SSH access to a freshly installed Omarchy laptop.
#
# Omarchy is installed from Harout's existing USB stick; he answers the
# installer's own questions. It does not enable sshd. So the very first thing
# after the first login is this one line, pasted by Harout in a terminal:
#
#   bash migrate/linux/enable-ssh.sh            # print the one-liner (default)
#   bash migrate/linux/enable-ssh.sh --apply    # run it here, on this machine
#   bash migrate/linux/enable-ssh.sh --keys extra.pub   # add another public key
#
# The line installs and enables openssh, adds the team's public keys to
# ~/.ssh/authorized_keys, opens port 22 when a local firewall is active, and
# prints the machine's LAN addresses. Nothing secret is in it: public keys only.
#
# After that, from the gaming PC:
#   ssh -i C:\Users\harou\.ssh\hbots-migrate_ed25519 harout@<printed-ip>
# and run migrate/linux/bootstrap.sh over that session.
#
set -euo pipefail

# Public keys only. Never add a private key here.
LAPTOP_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINC1E0A/tLjF6BZzb0BJSsLZRFxIu7RfyzXDI1mclrf5 hbots-cto@laptop'
GAMINGPC_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF1qEwhgBIgffD4H5yic6yVruPCeP7Vd4fu1I1bCWhX8 hbots-migrate@gamingpc'

MODE=print
EXTRA_KEYS=()

usage() {
  sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --print) MODE=print; shift ;;
    --apply) MODE=apply; shift ;;
    --keys)
      [ "$#" -ge 2 ] || { echo "ERROR: --keys needs a file." >&2; exit 2; }
      EXTRA_KEYS+=("$2")
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1 (use --help)" >&2; exit 2 ;;
  esac
done

KEYS=("$LAPTOP_KEY" "$GAMINGPC_KEY")
for file in "${EXTRA_KEYS[@]:-}"; do
  [ -n "$file" ] || continue
  [ -f "$file" ] || { echo "ERROR: key file not found: $file" >&2; exit 2; }
  while IFS= read -r line; do
    line="${line%$'\r'}"
    [ -n "$line" ] || continue
    case "$line" in
      ssh-*|ecdsa-*|sk-*) KEYS+=("$line") ;;
      *) echo "ERROR: $file does not look like a public key line: $line" >&2; exit 2 ;;
    esac
  done < "$file"
done

# One pasteable line. Single quotes are safe: public keys never contain one.
one_liner() {
  local line="sudo pacman -S --needed --noconfirm openssh && sudo systemctl enable --now sshd && install -d -m 700 ~/.ssh && touch ~/.ssh/authorized_keys"
  local key
  for key in "${KEYS[@]}"; do
    line+=" && (grep -qxF '$key' ~/.ssh/authorized_keys || echo '$key' >> ~/.ssh/authorized_keys)"
  done
  line+=" && chmod 600 ~/.ssh/authorized_keys"
  line+=" && { command -v ufw >/dev/null 2>&1 && sudo ufw status 2>/dev/null | grep -q active && sudo ufw allow 22/tcp || true; }"
  line+=" && ip -4 -o addr show scope global | awk '\$2 != \"lo\" {print \$2, \$4}'"
  printf '%s\n' "$line"
}

if [ "$MODE" = "print" ]; then
  cat <<'EOF'
Paste this ONE line in a terminal on the new laptop, right after the first
login. It enables sshd and adds the team's public keys. Then nothing else is
needed on the laptop until bootstrap runs over SSH.

EOF
  one_liner
  cat <<'EOF'

Then from the gaming PC:
  ssh -i C:\Users\harou\.ssh\hbots-migrate_ed25519 harout@<first address above>
EOF
  exit 0
fi

# --apply: the same steps, run here on the laptop.
if [ "$(id -u)" -eq 0 ]; then
  SUDO=()
else
  command -v sudo >/dev/null 2>&1 || { echo "ERROR: run as root or install sudo." >&2; exit 1; }
  SUDO=(sudo)
fi

echo "==> install and enable sshd"
"${SUDO[@]}" pacman -S --needed --noconfirm openssh
"${SUDO[@]}" systemctl enable --now sshd

echo "==> authorized_keys"
install -d -m 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
for key in "${KEYS[@]}"; do
  if grep -qxF "$key" "$HOME/.ssh/authorized_keys"; then
    echo "    already present: ${key##* }"
  else
    printf '%s\n' "$key" >> "$HOME/.ssh/authorized_keys"
    echo "    added: ${key##* }"
  fi
done
chmod 600 "$HOME/.ssh/authorized_keys"

echo "==> firewall port 22"
if command -v ufw >/dev/null 2>&1 && "$SUDO[@]" ufw status 2>/dev/null | grep -q 'Status: active'; then
  "$SUDO[@]" ufw allow 22/tcp comment 'ssh'
elif command -v firewall-cmd >/dev/null 2>&1 && "$SUDO[@]" firewall-cmd --state >/dev/null 2>&1; then
  "$SUDO[@]" firewall-cmd --permanent --add-service=ssh
  "$SUDO[@]" firewall-cmd --reload
else
  echo "    no active ufw/firewalld; nothing to open"
fi

echo "==> sshd status"
systemctl is-active sshd

echo "==> addresses"
ip -4 -o addr show scope global | awk '$2 != "lo" {print "    " $2, $4}'
echo
echo "SSH is ready. From the gaming PC:"
echo "  ssh -i C:\\Users\\harou\\.ssh\\hbots-migrate_ed25519 ${USER}@<address above>"
