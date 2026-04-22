#!/bin/bash
# Install the Point external backup service on Lab.
# Run as root (or with sudo) on the Lab machine.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root: sudo $0"
    exit 1
fi

echo "Installing point-backup.sh..."
install -m 755 "$SCRIPT_DIR/point-external-backup.sh" /usr/local/bin/point-backup.sh

echo "Installing systemd units..."
install -m 644 "$SCRIPT_DIR/point-backup.service" /etc/systemd/system/
install -m 644 "$SCRIPT_DIR/point-backup.timer"   /etc/systemd/system/

echo "Creating backup directory..."
mkdir -p /var/backups/point

echo "Reloading systemd and enabling timer..."
systemctl daemon-reload
systemctl enable --now point-backup.timer

echo ""
echo "Done. Timer status:"
systemctl status point-backup.timer --no-pager

echo ""
echo "To run a backup immediately:"
echo "  sudo systemctl start point-backup.service"
echo "  journalctl -u point-backup.service -f"
