#!/usr/bin/env bash
# Point Photo Blog — Interactive Setup Wizard
# Usage: bash install.sh [--method=docker|native] [--non-interactive]
set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────────────────
REPO="dariy/point"
GITHUB_API="https://api.github.com/repos/${REPO}/releases/latest"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/main"
POINT_VERSION=""   # filled by fetch_latest_version

# ── Color output ───────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

say()  { echo -e "${BLUE}▶${NC}  $*"; }
ok()   { echo -e "${GREEN}✓${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
err()  { echo -e "${RED}✗${NC}  $*" >&2; }
die()  { err "$*"; exit 1; }
hr()   { echo -e "${BLUE}────────────────────────────────────────────${NC}"; }

# ask "Question" "default" → echoes the answer (default if user hits Enter)
ask() {
  local prompt="$1" default="$2" answer=""
  local display; [ -n "$default" ] && display="${prompt} [${default}]: " || display="${prompt}: "
  IFS= read -rp "$(echo -e "${BOLD}${display}${NC}")" answer </dev/tty || true
  echo "${answer:-${default}}"
}

# ask_yn "Question" "y|n" → echoes "y" or "n"
ask_yn() {
  local prompt="$1" default="${2:-y}" answer=""
  local hint; [ "$default" = "y" ] && hint="Y/n" || hint="y/N"
  IFS= read -rp "$(echo -e "${BOLD}${prompt}${NC} [${hint}]: ")" answer </dev/tty || true
  answer="${answer:-$default}"
  case "$answer" in [Yy]*) echo "y";; *) echo "n";; esac
}

# ── Banner ─────────────────────────────────────────────────────────────────────
show_banner() {
  echo ""
  echo -e "${BOLD}${BLUE}  ╔═══════════════════════════════════╗${NC}"
  echo -e "${BOLD}${BLUE}  ║   Point Photo Blog — Installer    ║${NC}"
  echo -e "${BOLD}${BLUE}  ╚═══════════════════════════════════╝${NC}"
  echo ""
}

# ── CLI argument parsing ────────────────────────────────────────────────────────
METHOD_ARG=""
NON_INTERACTIVE=false

for arg in "$@"; do
  case "$arg" in
    --method=docker)      METHOD_ARG="docker" ;;
    --method=native)      METHOD_ARG="native" ;;
    --non-interactive)    NON_INTERACTIVE=true ;;
    --help|-h)
      echo "Usage: bash install.sh [--method=docker|native] [--non-interactive]"
      echo ""
      echo "  --method=docker     Install using Docker Compose (default)"
      echo "  --method=native     Install as native Linux binary + systemd service"
      echo "  --non-interactive   Accept all defaults without prompting"
      exit 0
      ;;
    *) warn "Unknown argument: $arg" ;;
  esac
done

# Wrapper: in non-interactive mode, always returns the default
maybe_ask() {
  if [ "$NON_INTERACTIVE" = "true" ]; then echo "$2"; else ask "$1" "$2"; fi
}

# ── Placeholders (filled in subsequent tasks) ──────────────────────────────────
# ── Install method selection ───────────────────────────────────────────────────
pick_install_method() {
  if [ -n "$METHOD_ARG" ]; then echo "$METHOD_ARG"; return; fi

  echo ""
  echo -e "How would you like to install Point?"
  echo -e "  ${BOLD}1)${NC} Docker / Podman  ${GREEN}(recommended — easiest, safest)${NC}"
  echo -e "  ${BOLD}2)${NC} Native Linux binary + systemd service"
  echo ""
  local choice
  choice=$(maybe_ask "Choose [1/2]" "1")
  case "$choice" in
    2|native) echo "native" ;;
    *)        echo "docker" ;;
  esac
}
# ── Config collection ──────────────────────────────────────────────────────────
# Globals set by collect_config:
#   PORT           - port Point listens on
#   DATA_DIR       - absolute path to data directory
#   GEMINI_KEY     - Gemini API key (optional, may be empty)
#   PHOTO_LIB_PATH - existing photo library path (optional, may be empty)
#   INSTALL_DIR    - directory where compose/env files live (docker) or app lives (native)

collect_config() {
  local method="$1"
  echo ""
  say "Configuration  (press Enter to accept defaults)"
  echo ""

  if [ "$method" = "docker" ]; then
    INSTALL_DIR=$(maybe_ask "Install directory" "$HOME/point")
    DATA_DIR=$(maybe_ask "Data directory" "${INSTALL_DIR}/data")
    PORT=8000   # docker-compose.yml hardcodes PORT=8000 in the environment block;
                # it cannot be overridden via .env without editing the compose file
    say "Note: Docker install uses port 8000 (set in docker-compose.yml)"
  else
    INSTALL_DIR="/opt/point"
    DATA_DIR=$(maybe_ask "Data directory" "/var/lib/point")
    PORT=$(maybe_ask "Port" "8000")
  fi

  echo ""
  say "Optional: Gemini API key enables AI photo analysis (leave blank to skip)"
  GEMINI_KEY=$(maybe_ask "Gemini API key" "")

  echo ""
  say "Optional: path to an existing photo library to import (leave blank to skip)"
  PHOTO_LIB_PATH=$(maybe_ask "Photo library path" "")
}
install_via_docker()  { die "Not yet implemented"; }
install_native()      { die "Not yet implemented"; }
wait_for_health()     { :; }
show_success()        { ok "Done."; }

# ── Main ───────────────────────────────────────────────────────────────────────
main() {
  show_banner

  INSTALL_METHOD=$(pick_install_method)
  collect_config "$INSTALL_METHOD"

  hr
  say "Starting installation (method: ${BOLD}${INSTALL_METHOD}${NC})"
  hr

  if [ "$INSTALL_METHOD" = "docker" ]; then
    install_via_docker
  else
    install_native
  fi

  wait_for_health
  show_success
}

main "$@"
