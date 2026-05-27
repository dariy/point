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

check_os() {
  if [[ "$OSTYPE" != "linux-gnu"* ]]; then
    warn "This script is optimized for Linux. Continuing anyway..."
  fi
}

# ── CLI argument parsing ────────────────────────────────────────────────────────
METHOD_ARG=""
NON_INTERACTIVE=false
AUTO_PORT=""
TEST_MODE=false

for arg in "$@"; do
  case "$arg" in
    --method=docker)      METHOD_ARG="docker" ;;
    --method=native)      METHOD_ARG="native" ;;
    --non-interactive)    NON_INTERACTIVE=true ;;
    --auto)               NON_INTERACTIVE=true; AUTO_PORT="8001" ;;
    --test)               TEST_MODE=true ;;
    --help|-h)
      echo "Usage: bash install.sh [--method=docker|native] [--non-interactive] [--auto] [--test]"
      echo ""
      echo "  --method=docker     Install using Docker Compose (default)"
      echo "  --method=native     Install as native Linux binary + systemd service"
      echo "  --non-interactive   Accept all defaults without prompting"
      echo "  --test              Test mode: use localhost/point:dev image in Docker Compose"
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
    APP_PORT=$(maybe_ask "Host Port" "${AUTO_PORT:-8000}")
    PORT=8000
    say "Note: Docker install uses host port ${APP_PORT} (inner port ${PORT})"
  else
    INSTALL_DIR="/opt/point"
    DATA_DIR=$(maybe_ask "Data directory" "/var/lib/point")
    PORT=$(maybe_ask "Port" "${AUTO_PORT:-8000}")
    APP_PORT=$PORT
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
  if [ -f "$env_path" ]; then
    say "Found existing ${env_path}. Leaving it untouched."
    return
  fi
  say "Writing ${env_path}..."
  cat > "$env_path" <<EOF
# Point configuration — generated by install.sh
PORT=${PORT}
APP_PORT=${APP_PORT}
DATA_PATH=${DATA_DIR}
EOF
  if [ -n "$GEMINI_KEY" ]; then
    echo "GEMINI_API_KEY=${GEMINI_KEY}" >> "$env_path"
  fi
  if [ -n "$PHOTO_LIB_PATH" ]; then
    echo "PHOTO_LIBRARY_PATH=${PHOTO_LIB_PATH}" >> "$env_path"
    if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
      sed -i 's|# - PHOTO_LIBRARY_PATH=/photos|- PHOTO_LIBRARY_PATH=/photos|' "$INSTALL_DIR/docker-compose.yml"
      sed -i 's|# - ${PHOTO_LIBRARY_PATH:-./import}:/photos:ro,z|- ${PHOTO_LIBRARY_PATH:-./import}:/photos:ro,z|' "$INSTALL_DIR/docker-compose.yml"
    fi
  fi
  ok ".env written"
}

install_via_docker() {
  ensure_compose

  say "Creating install directory: $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR" "$DATA_DIR" "${INSTALL_DIR}/import"

  # Rootless Podman maps container UIDs through a user namespace.
  # The container app user (UID 1000) maps to a different host UID than the
  # current user.  We must re-own the data directory from inside the namespace
  # so the container can write the database and media files.
  if [[ "$COMPOSE" == *podman* ]]; then
    say "Fixing data directory ownership for rootless Podman..."
    podman unshare chown -R 1000:1000 "$DATA_DIR" 2>/dev/null || \
      warn "Could not fix data dir ownership — container may not be able to write to $DATA_DIR"
  fi

  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  if [ -f "${script_dir}/docker-compose.yml" ] && [ -f "${script_dir}/update.sh" ]; then
    say "Found local docker-compose.yml and update.sh, copying..."
    cp "${script_dir}/docker-compose.yml" "${INSTALL_DIR}/docker-compose.yml"
    cp "${script_dir}/update.sh" "${INSTALL_DIR}/update.sh"
  else
    say "Downloading docker-compose.yml and update.sh..."
    curl -fsSL "${RAW_BASE}/quickstart/docker-compose.yml" \
      -o "${INSTALL_DIR}/docker-compose.yml"
    curl -fsSL "${RAW_BASE}/quickstart/update.sh" \
      -o "${INSTALL_DIR}/update.sh"
  fi
  chmod +x "${INSTALL_DIR}/update.sh"
  ok "Files saved to ${INSTALL_DIR}"

  if [ "$TEST_MODE" = "true" ]; then
    say "Test mode: configuring docker-compose to use localhost/point:dev"
    sed -i 's|image: ghcr.io/dariy/point:latest|image: localhost/point:dev|' "${INSTALL_DIR}/docker-compose.yml"
  fi

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

  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local project_root="$(cd "$script_dir/.." && pwd)"

  say "Installing to ${INSTALL_DIR}..."
  mkdir -p "$INSTALL_DIR" "$DATA_DIR"

  if [ -f "${project_root}/point" ]; then
    say "Found local point binary, copying..."
    cp "${project_root}/point" "${INSTALL_DIR}/point"
    if [ -d "${project_root}/frontend" ]; then
      cp -r "${project_root}/frontend" "${INSTALL_DIR}/"
    fi
  elif [ -f "${project_root}/api/cmd/api/main.go" ]; then
    say "Found source code, building..."
    if ! command -v go >/dev/null 2>&1; then
      die "Go compiler not found. Please install Go or use Docker."
    fi
    if command -v npm >/dev/null 2>&1; then
      say "Building frontend assets..."
      (cd "${project_root}" && sh scripts/build-js.sh && sh scripts/build-css.sh)
    else
      warn "npm not found. Frontend assets will not be updated from source."
    fi
    (cd "${project_root}/api" && go build -o "${INSTALL_DIR}/point" cmd/api/main.go)
    if [ -d "${project_root}/frontend" ]; then
      cp -r "${project_root}/frontend" "${INSTALL_DIR}/"
    fi
  else
    local arch; arch=$(detect_arch)
    fetch_latest_version

    local tarball; tarball=$(download_tarball "$arch" "$POINT_VERSION")

    tar -xzf "$tarball" -C /tmp
    # tarball extracts to /tmp/point-linux-${arch}/
    cp -r "/tmp/point-linux-${arch}/." "$INSTALL_DIR/"
    rm -rf "/tmp/point-linux-${arch}" "$tarball"
  fi

  chmod +x "${INSTALL_DIR}/point"
  ok "Files installed to ${INSTALL_DIR}"

  create_point_user
  chown -R point:point "$INSTALL_DIR" "$DATA_DIR"

  write_env_file "${INSTALL_DIR}/.env"
  chown point:point "${INSTALL_DIR}/.env"
  chmod 600 "${INSTALL_DIR}/.env"

  install_systemd_service "$PORT"
}
wait_for_health() {
  local url="http://localhost:${APP_PORT}/health"
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

prompt_account_setup() {
  if [ "$NON_INTERACTIVE" = "true" ]; then return; fi

  # Check if setup is already complete
  if curl -fsS "http://localhost:${APP_PORT}/api/setup/status" | grep -q '"setup_complete":true'; then
    return
  fi

  echo ""
  local do_setup
  do_setup=$(ask_yn "Would you like to create an admin account now?" "y")
  if [ "$do_setup" != "y" ]; then return; fi

  echo ""
  say "Admin Account Setup"
  local title; title=$(ask "Blog Title" "My Photo Blog")
  local name; name=$(ask "Your Name" "Admin")
  local email; email=$(ask "Email Address" "")

  local pass; local pass_confirm
  while true; do
    printf "${BOLD}Password: ${NC}" >&2
    read -rs pass </dev/tty
    echo "" >&2
    printf "${BOLD}Confirm Password: ${NC}" >&2
    read -rs pass_confirm </dev/tty
    echo "" >&2
    if [ "$pass" = "$pass_confirm" ] && [ -n "$pass" ]; then
      if [ ${#pass} -lt 8 ]; then
        err "Password must be at least 8 characters."
      else
        break
      fi
    else
      err "Passwords do not match or are empty. Try again."
    fi
  done

  local pass_hash; pass_hash=$(echo -n "$pass" | sha256sum | awk '{print $1}')

  say "Finalizing setup..."
  if [ "$INSTALL_METHOD" = "docker" ]; then
    (cd "$INSTALL_DIR" && $COMPOSE exec -T point ./point setup --title="$title" --user="$name" --email="$email" --password="$pass_hash")
  else
    (cd "$INSTALL_DIR" && ./point setup --title="$title" --user="$name" --email="$email" --password="$pass_hash")
    chown point:point "$DATA_DIR/point.db" 2>/dev/null || true
  fi
  ok "Admin account created!"
}

show_success() {
  local url="http://localhost:${APP_PORT}"
  echo ""
  hr
  echo -e "${GREEN}${BOLD}  Point is running!${NC}"
  hr
  echo ""
  echo -e "  ${BOLD}Open in your browser:${NC}  ${url}"
  echo ""
  if ! curl -fsS "http://localhost:${APP_PORT}/api/setup/status" | grep -q '"setup_complete":true'; then
    echo -e "  The setup wizard will appear on first visit."
    echo -e "  Create your admin account and you're done."
  else
    echo -e "  Log in at ${url}/light with the account you just created."
  fi
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
  check_os

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
  prompt_account_setup
  show_success
}

main "$@"

