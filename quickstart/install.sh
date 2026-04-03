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

  echo "" >&2
  echo -e "How would you like to install Point?" >&2
  echo -e "  ${BOLD}1)${NC} Docker / Podman  ${GREEN}(recommended — easiest, safest)${NC}" >&2
  echo -e "  ${BOLD}2)${NC} Native Linux binary + systemd service" >&2
  echo "" >&2
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
# ── Docker helpers ─────────────────────────────────────────────────────────────

# Sets COMPOSE global to "docker compose" or "podman compose"
detect_compose_engine() {
  # 1. Prefer docker if it works without sudo
  if command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
    return
  fi

  # 2. Prefer podman if it works without sudo
  if command -v podman >/dev/null 2>&1 && podman ps >/dev/null 2>&1; then
    COMPOSE="podman compose"
    return
  fi

  # 3. Fallback to docker with sudo
  if command -v docker >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && sudo -n docker compose version >/dev/null 2>&1; then
    COMPOSE="sudo docker compose"
    return
  fi

  # 4. Fallback to podman with sudo
  if command -v podman >/dev/null 2>&1 && sudo -n podman ps >/dev/null 2>&1; then
    COMPOSE="sudo podman compose"
    return
  fi

  # 5. Last resort (daemon might be asleep, just return the command)
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
  elif command -v podman >/dev/null 2>&1; then
    COMPOSE="podman compose"
  else
    COMPOSE=""
  fi
}

install_docker_ubuntu() {
  say "Installing Docker Engine..."
  if [ "$(id -u)" -ne 0 ]; then
    die "Docker installation requires root. Re-run with sudo, or install Docker manually: https://docs.docker.com/engine/install/ubuntu/"
  fi
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg lsb-release
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
     https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl start docker
  systemctl enable docker
  ok "Docker installed"
}

ensure_compose() {
  detect_compose_engine
  if [ -n "$COMPOSE" ]; then
    ok "Found: $COMPOSE"
    return
  fi
  warn "Docker / Podman not found."
  local install_it
  install_it=$(ask_yn "Install Docker Engine now?" "y")
  if [ "$install_it" = "y" ]; then
    install_docker_ubuntu
    COMPOSE="docker compose"
  else
    die "Docker is required for the Docker install method. Install it from https://docs.docker.com/engine/install/ and re-run this script."
  fi
}

write_env_file() {
  local env_path="$1"
  say "Writing ${env_path}..."
  cat > "$env_path" <<EOF
# Point configuration — generated by install.sh
PORT=${PORT}
DATA_PATH=${DATA_DIR}
EOF
  if [ -n "$GEMINI_KEY" ]; then
    echo "GEMINI_API_KEY=${GEMINI_KEY}" >> "$env_path"
  fi
  if [ -n "$PHOTO_LIB_PATH" ]; then
    echo "PHOTO_LIBRARY_PATH=${PHOTO_LIB_PATH}" >> "$env_path"
  fi
  ok ".env written"
}

install_via_docker() {
  ensure_compose

  say "Creating install directory: $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR" "$DATA_DIR"

  say "Downloading docker-compose.yml and update.sh..."
  curl -fsSL "${RAW_BASE}/quickstart/docker-compose.yml" \
    -o "${INSTALL_DIR}/docker-compose.yml"
  curl -fsSL "${RAW_BASE}/quickstart/update.sh" \
    -o "${INSTALL_DIR}/update.sh"
  chmod +x "${INSTALL_DIR}/update.sh"
  ok "Files saved to ${INSTALL_DIR}"

  write_env_file "${INSTALL_DIR}/.env"

  say "Starting Point..."
  (cd "$INSTALL_DIR" && $COMPOSE up -d)
  ok "Container started"
}
# ── Native install helpers ─────────────────────────────────────────────────────

detect_arch() {
  case "$(uname -m)" in
    x86_64)  echo "amd64" ;;
    aarch64) echo "arm64" ;;
    armv7l)  echo "arm64" ;;  # best-effort
    *) die "Unsupported architecture: $(uname -m). Only amd64 and arm64 are supported." ;;
  esac
}

fetch_latest_version() {
  say "Fetching latest release info from GitHub..."
  local tag
  tag=$(curl -fsSL "$GITHUB_API" | grep '"tag_name"' | head -1 \
        | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
  if [ -z "$tag" ]; then
    die "Could not determine latest release. Check your internet connection or visit https://github.com/${REPO}/releases"
  fi
  POINT_VERSION="$tag"
  ok "Latest release: $POINT_VERSION"
}

download_tarball() {
  local arch="$1"
  local version="$2"
  local tarball="point-linux-${arch}.tar.gz"
  local url="https://github.com/${REPO}/releases/download/${version}/${tarball}"
  say "Downloading ${tarball}..." >&2
  curl -fsSL "$url" -o "/tmp/${tarball}"
  ok "Downloaded to /tmp/${tarball}" >&2
  echo "/tmp/${tarball}"
}

create_point_user() {
  if ! id -u point >/dev/null 2>&1; then
    say "Creating system user 'point'..."
    useradd --system --no-create-home --shell /usr/sbin/nologin point
    ok "User 'point' created"
  else
    ok "User 'point' already exists"
  fi
}

install_systemd_service() {
  local port="$1"
  say "Installing systemd service..."
  cat > /etc/systemd/system/point.service <<EOF
[Unit]
Description=Point Photo Blog
After=network.target

[Service]
Type=simple
User=point
Group=point
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
Environment=DATABASE_URL=${DATA_DIR}/point.db
Environment=STORAGE_PATH=${DATA_DIR}
Environment=FRONTEND_DIR=${INSTALL_DIR}/frontend
Environment=PORT=${port}
Environment=HOST=0.0.0.0
ExecStart=${INSTALL_DIR}/point
Restart=on-failure
RestartSec=5s
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now point
  ok "Service enabled and started"
}

install_native() {
  if [ "$(id -u)" -ne 0 ]; then
    die "Native installation requires root. Re-run with sudo."
  fi

  local arch; arch=$(detect_arch)
  fetch_latest_version

  local tarball; tarball=$(download_tarball "$arch" "$POINT_VERSION")

  say "Installing to ${INSTALL_DIR}..."
  mkdir -p "$INSTALL_DIR" "$DATA_DIR"
  tar -xzf "$tarball" -C /tmp
  # tarball extracts to /tmp/point-linux-${arch}/
  cp -r "/tmp/point-linux-${arch}/." "$INSTALL_DIR/"
  chmod +x "${INSTALL_DIR}/point"
  rm -rf "/tmp/point-linux-${arch}" "$tarball"
  ok "Files installed to ${INSTALL_DIR}"

  create_point_user
  chown -R point:point "$INSTALL_DIR" "$DATA_DIR"

  write_env_file "${INSTALL_DIR}/.env"
  chown point:point "${INSTALL_DIR}/.env"
  chmod 600 "${INSTALL_DIR}/.env"

  install_systemd_service "$PORT"
}
wait_for_health() {
  local url="http://localhost:${PORT}/health"
  local max_attempts=30  # 30 × 2s = 60s timeout
  local attempt=0

  say "Waiting for Point to be ready at ${url}..."
  while [ $attempt -lt $max_attempts ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      ok "Point is up!"
      return 0
    fi
    attempt=$((attempt + 1))
    printf "."
    sleep 2
  done
  echo ""
  warn "Point did not respond within 60 seconds."
  warn "Check logs with: journalctl -u point -f  (native)  or  docker logs point  (Docker)"
}

show_success() {
  local url="http://localhost:${PORT}"
  echo ""
  hr
  echo -e "${GREEN}${BOLD}  Point is running!${NC}"
  hr
  echo ""
  echo -e "  ${BOLD}Open in your browser:${NC}  ${url}"
  echo ""
  echo -e "  The setup wizard will appear on first visit."
  echo -e "  Create your admin account and you're done."
  echo ""
  if [ "$INSTALL_METHOD" = "docker" ]; then
    echo -e "  ${BOLD}Useful commands:${NC}"
    echo -e "    Update:    cd ${INSTALL_DIR} && bash update.sh"
    echo -e "    Logs:      cd ${INSTALL_DIR} && docker compose logs -f"
    echo -e "    Stop:      cd ${INSTALL_DIR} && docker compose down"
  else
    echo -e "  ${BOLD}Useful commands:${NC}"
    echo -e "    Logs:      journalctl -u point -f"
    echo -e "    Restart:   systemctl restart point"
    echo -e "    Stop:      systemctl stop point"
  fi
  echo ""
}

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
