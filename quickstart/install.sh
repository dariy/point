#!/usr/bin/env bash
# Point Photo Blog — Interactive Setup Wizard
# Usage: bash install.sh [--method=docker|native] [--port=8000] [--non-interactive]
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
  if [ -n "$default" ]; then
    read -rp "$(echo -e "${BOLD}${prompt}${NC} [${default}]: ")" answer || true
    echo "${answer:-$default}"
  else
    read -rp "$(echo -e "${BOLD}${prompt}${NC}: ")" answer || true
    echo "$answer"
  fi
}

# ask_yn "Question" "y|n" → echoes "y" or "n"
ask_yn() {
  local prompt="$1" default="${2:-y}" answer=""
  local hint; [ "$default" = "y" ] && hint="Y/n" || hint="y/N"
  read -rp "$(echo -e "${BOLD}${prompt}${NC} [${hint}]: ")" answer || true
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
  if $NON_INTERACTIVE; then echo "$2"; else ask "$1" "$2"; fi
}

# ── Placeholders (filled in subsequent tasks) ──────────────────────────────────
pick_install_method() { echo "docker"; }
collect_config()      { :; }
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
