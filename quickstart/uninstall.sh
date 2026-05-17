#!/usr/bin/env bash
# Point Photo Blog — Uninstaller
set -euo pipefail

# ── Colors & Helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

say()  { echo -e "${BLUE}▶${NC}  $*"; }
ok()   { echo -e "${GREEN}✓${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
err()  { echo -e "${RED}✗${NC}  $*" >&2; }
die()  { err "$*"; exit 1; }
hr()   { echo -e "${BLUE}────────────────────────────────────────────${NC}"; }

ask() {
  local prompt="$1" default="$2" answer=""
  local display; [ -n "$default" ] && display="${prompt} [${default}]: " || display="${prompt}: "
  IFS= read -rp "$(echo -e "${BOLD}${display}${NC}")" answer </dev/tty || true
  echo "${answer:-${default}}"
}

ask_yn() {
  local prompt="$1" default="${2:-y}" answer=""
  local hint; [ "$default" = "y" ] && hint="Y/n" || hint="y/N"
  IFS= read -rp "$(echo -e "${BOLD}${prompt}${NC} [${hint}]: ")" answer </dev/tty || true
  answer="${answer:-$default}"
  case "$answer" in [Yy]*) echo "y";; *) echo "n";; esac
}

maybe_ask() {
  if [ "$AUTO_MODE" = "true" ]; then echo "$2"; else ask "$1" "$2"; fi
}

maybe_ask_yn() {
  if [ "$AUTO_MODE" = "true" ]; then echo "$2"; else ask_yn "$1" "$2"; fi
}

# ── CLI argument parsing ────────────────────────────────────────────────────────
AUTO_MODE=false
METHOD_ARG=""
INSTALL_DIR_ARG=""
DATA_DIR_ARG=""

for arg in "$@"; do
  case "$arg" in
    --auto|-y|--yes)      AUTO_MODE=true ;;
    --method=docker)      METHOD_ARG="docker" ;;
    --method=native)      METHOD_ARG="native" ;;
    --method=both)        METHOD_ARG="both" ;;
    --install-dir=*)      INSTALL_DIR_ARG="${arg#*=}" ;;
    --data-dir=*)         DATA_DIR_ARG="${arg#*=}" ;;
    --help|-h)
      echo "Usage: bash uninstall.sh [--method=docker|native|both] [--auto]"
      echo "  --auto, -y, --yes   Skip all prompts and remove selected installations"
      echo "  --method=...        Force uninstall method (docker, native, or both)"
      echo "  --install-dir=...   Override installation directory to remove"
      echo "  --data-dir=...      Override data directory to remove"
      exit 0
      ;;
    *) warn "Unknown argument: $arg" ;;
  esac
done

detect_compose_engine() {
  if command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
    return
  fi
  if command -v podman >/dev/null 2>&1 && podman ps >/dev/null 2>&1; then
    COMPOSE="podman compose"
    return
  fi
  if command -v docker >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && sudo -n docker compose version >/dev/null 2>&1; then
    COMPOSE="sudo docker compose"
    return
  fi
  if command -v podman >/dev/null 2>&1 && sudo -n podman ps >/dev/null 2>&1; then
    COMPOSE="sudo podman compose"
    return
  fi
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
  elif command -v podman >/dev/null 2>&1; then
    COMPOSE="podman compose"
  else
    COMPOSE=""
  fi
}

# State vars
HAS_DOCKER=false
HAS_NATIVE=false

# 1. Detect installations
echo ""
say "Detecting Point installations..."

DOCKER_INSTALL_DIR="${INSTALL_DIR_ARG:-$HOME/point}"
if [ -f "$DOCKER_INSTALL_DIR/docker-compose.yml" ] || [ -d "$DOCKER_INSTALL_DIR/data" ]; then
    HAS_DOCKER=true
    say "Found Docker installation at $DOCKER_INSTALL_DIR"
fi

NATIVE_INSTALL_DIR="${INSTALL_DIR_ARG:-/opt/point}"
NATIVE_DATA_DIR="${DATA_DIR_ARG:-/var/lib/point}"
if systemctl list-unit-files 2>/dev/null | grep -q "^point.service" || \
   [ -d "$NATIVE_INSTALL_DIR" ] || \
   [ -f "/etc/systemd/system/point.service" ] || \
   pgrep -f "[ /]point$" >/dev/null 2>&1 || \
   (command -v lsof >/dev/null 2>&1 && lsof -i :8000 >/dev/null 2>&1); then
    HAS_NATIVE=true
    say "Found Native installation"
fi

if [ "$HAS_DOCKER" = false ] && [ "$HAS_NATIVE" = false ] && [ -z "$METHOD_ARG" ]; then
    die "No Point installations found at default locations. If it is installed in a custom directory, use --install-dir="
fi

TARGET_METHOD="$METHOD_ARG"
if [ -z "$TARGET_METHOD" ]; then
    if [ "$HAS_DOCKER" = true ] && [ "$HAS_NATIVE" = true ]; then
        echo "" >&2
        echo -e "Multiple installations detected. What would you like to uninstall?" >&2
        echo -e "  ${BOLD}1)${NC} Docker" >&2
        echo -e "  ${BOLD}2)${NC} Native" >&2
        echo -e "  ${BOLD}3)${NC} Both" >&2
        choice=$(maybe_ask "Choose [1/2/3]" "3")
        case "$choice" in
            1|docker) TARGET_METHOD="docker" ;;
            2|native) TARGET_METHOD="native" ;;
            *)        TARGET_METHOD="both" ;;
        esac
    elif [ "$HAS_DOCKER" = true ]; then
        TARGET_METHOD="docker"
    elif [ "$HAS_NATIVE" = true ]; then
        TARGET_METHOD="native"
    fi
fi

echo ""
warn "WARNING: This will completely remove Point and ALL its data."
confirm=$(maybe_ask_yn "Are you absolutely sure you want to proceed?" "n")
if [ "$confirm" != "y" ]; then
    say "Uninstall cancelled."
    exit 0
fi

uninstall_docker() {
    hr
    say "Uninstalling Docker version..."
    local dir="${INSTALL_DIR_ARG:-$HOME/point}"
    if [ ! -d "$dir" ]; then
        warn "Directory $dir not found. Skipping docker compose down."
    else
        detect_compose_engine
        if [ -n "$COMPOSE" ] && [ -f "$dir/docker-compose.yml" ]; then
            say "Stopping containers and removing volumes..."
            (cd "$dir" && $COMPOSE down -v || true)
            ok "Containers stopped"
        else
            warn "Compose engine not found or docker-compose.yml missing. Removing directory directly."
        fi
        
        if [ -f "$dir/.env" ]; then
            local data_path
            data_path=$(grep "^DATA_PATH=" "$dir/.env" | cut -d= -f2- || true)
            if [ -n "$data_path" ] && [ "$data_path" != "$dir/data" ] && [ -d "$data_path" ]; then
                say "Removing external data directory $data_path..."
                rm -rf "$data_path"
            fi
        fi

        say "Removing directory $dir..."
        rm -rf "$dir"
        ok "Removed $dir"
    fi
}

uninstall_native() {
    hr
    say "Uninstalling Native version..."
    if [ "$(id -u)" -ne 0 ]; then
        die "Native uninstallation requires root. Re-run with sudo (e.g. sudo bash uninstall.sh --method=native)."
    fi

    local dir="${INSTALL_DIR_ARG:-/opt/point}"
    local datadir="${DATA_DIR_ARG:-/var/lib/point}"

    # Stop any running Point processes
    if pgrep -f "[ /]point$" >/dev/null 2>&1; then
        say "Stopping running point process..."
        pkill -f "[ /]point$" || true
        sleep 1
    fi
    if command -v lsof >/dev/null 2>&1; then
        for pid in $(lsof -t -i :8000 2>/dev/null || true); do
            if ps -p "$pid" -o comm= 2>/dev/null | grep -qE "point"; then
                say "Stopping Point process on port 8000 (PID $pid)..."
                kill "$pid" 2>/dev/null || true
            fi
        done
    fi

    if systemctl is-active --quiet point 2>/dev/null; then
        say "Stopping systemd service..."
        systemctl stop point || true
    fi

    if systemctl is-enabled --quiet point 2>/dev/null; then
        say "Disabling systemd service..."
        systemctl disable point || true
    fi

    if [ -f "/etc/systemd/system/point.service" ]; then
        say "Removing systemd service file..."
        rm -f /etc/systemd/system/point.service
        systemctl daemon-reload
    fi

    if id -u point >/dev/null 2>&1; then
        say "Removing system user 'point'..."
        userdel point || true
    fi

    if [ -d "$dir" ]; then
        say "Removing installation directory $dir..."
        rm -rf "$dir"
    fi

    if [ -d "$datadir" ]; then
        say "Removing data directory $datadir..."
        rm -rf "$datadir"
    fi

    ok "Native version uninstalled"
}

if [ "$TARGET_METHOD" = "docker" ] || [ "$TARGET_METHOD" = "both" ]; then
    uninstall_docker
fi

if [ "$TARGET_METHOD" = "native" ] || [ "$TARGET_METHOD" = "both" ]; then
    uninstall_native
fi

hr
ok "Uninstall complete!"
echo ""