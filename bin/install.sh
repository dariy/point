#!/usr/bin/env bash
# Point Photo Blog — Setup Wizard
# Works on: Linux (Ubuntu) / Docker
set -euo pipefail

# --- Constants ---
NAME="point"
DEFAULT_PORT=8000
DEFAULT_INSTALL_DIR="$HOME/point"
DEFAULT_DATA_DIR="$HOME/point/data"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

say()  { echo -e "${BLUE}▶${NC}  $*"; }
ok()   { echo -e "${GREEN}✓${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
err()  { echo -e "${RED}✗${NC}  $*" >&2; }
die()  { err "$*"; exit 1; }
hr()   { echo -e "${BLUE}──────────────────────────────────────────────────────────${NC}"; }

ask() {
    local prompt="$1" default="$2" answer=""
    if [[ "${AUTO_MODE:-false}" == "true" ]]; then
        echo "$default"
        return
    fi
    echo -ne "${BOLD}${prompt}${NC} [${default}]: " >&2
    read -r answer < /dev/tty || answer=""
    echo "${answer:-$default}"
}

show_banner() {
    clear
    echo -e "${BLUE}${BOLD}"
    echo "  ╔══════════════════════════════════════════╗"
    echo "  ║         Point Photo Blog — Setup         ║"
    echo "  ╚══════════════════════════════════════════╝"
    echo -e "${NC}"
}

check_os() {
    if [[ "$OSTYPE" != "linux-gnu"* ]]; then
        warn "This script is optimized for Linux. Continuing anyway..."
    fi
}

# --- Installation Methods ---

install_docker() {
    say "Setting up Point with Docker..."
    
    local install_dir; install_dir=$(ask "Installation directory" "$DEFAULT_INSTALL_DIR")
    local data_dir; data_dir=$(ask "Data directory" "$DEFAULT_DATA_DIR")
    PORT=$(ask "Port" "$DEFAULT_PORT")
    local gemini_key; gemini_key=$(ask "Gemini API Key (optional)" "")

    mkdir -p "$install_dir" "$data_dir"

    # Create .env file
    cat > "$install_dir/.env" <<EOF
NAME=$NAME
PORT=$PORT
DATA_PATH=$data_dir
GEMINI_API_KEY=$gemini_key
EOF
    ok "Created .env in $install_dir"

    # Use existing quickstart compose if available, or create one
    if [ -f "quickstart/docker-compose.yml" ]; then
        cp quickstart/docker-compose.yml "$install_dir/"
    else
        say "Creating docker-compose.yml..."
        cat > "$install_dir/docker-compose.yml" <<EOC
services:
  point:
    image: ghcr.io/dariy/point:latest
    container_name: point
    restart: unless-stopped
    ports:
      - "$PORT:8000"
    env_file: .env
    volumes:
      - "$data_dir:/data"
EOC
    fi

    # Check for docker
    if ! command -v docker &> /dev/null; then
        say "Docker not found. Attempting to install..."
        if command -v apt-get &> /dev/null; then
            sudo apt-get update && sudo apt-get install -y docker.io docker-compose
        else
            die "Please install Docker and Docker Compose manually, then re-run."
        fi
    fi

    say "Starting Point..."
    (cd "$install_dir" && sudo docker-compose up -d)
    ok "Point is running on http://localhost:$PORT"
}

install_native() {
    say "Setting up Point natively on Ubuntu..."
    
    if ! command -v apt-get &> /dev/null; then
        die "Native install currently only supports Ubuntu/Debian (apt-get not found)."
    fi

    local install_dir; install_dir=$(ask "Installation directory" "$DEFAULT_INSTALL_DIR")
    local data_dir; data_dir=$(ask "Data directory" "$DEFAULT_DATA_DIR")
    PORT=$(ask "Port" "$DEFAULT_PORT")
    local gemini_key; gemini_key=$(ask "Gemini API Key (optional)" "")

    sudo mkdir -p "$install_dir" "$data_dir"
    sudo chown "$USER:$USER" "$install_dir" "$data_dir"

    # Install dependencies
    say "Installing system dependencies..."
    sudo apt-get update
    sudo apt-get install -y ca-certificates curl tzdata

    # Fetch binary
    say "Fetching latest Point binary..."
    if [ -f "api-bin" ]; then
        cp api-bin "$install_dir/point"
    elif [ -f "api/cmd/api/main.go" ]; then
        say "Building from source..."
        (cd api && go build -o "../$install_dir/point" cmd/api/main.go)
    else
        warn "Binary not found and couldn't build. Please ensure you have the 'point' binary."
    fi
    
    if [ -d "frontend" ]; then
        cp -r frontend "$install_dir/"
    fi

    chmod +x "$install_dir/point"

    # Create .env
    cat > "$install_dir/.env" <<EOF
PORT=$PORT
DATABASE_URL=$data_dir/point.db
STORAGE_PATH=$data_dir
FRONTEND_DIR=$install_dir/frontend
GEMINI_API_KEY=$gemini_key
EOF

    # Create systemd service
    say "Creating systemd service..."
    cat <<EOS | sudo tee /etc/systemd/system/point.service > /dev/null
[Unit]
Description=Point Photo Blog
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$install_dir
EnvironmentFile=$install_dir/.env
ExecStart=$install_dir/point
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOS

    sudo systemctl daemon-reload
    sudo systemctl enable point
    sudo systemctl start point

    ok "Point service started. Running on http://localhost:$PORT"
}

# --- Main ---

main() {
    AUTO_MODE=false
    for arg in "$@"; do
        case $arg in
            --auto)
                AUTO_MODE=true
                DEFAULT_PORT=8001
                ;;
        esac
    done

    show_banner
    check_os

    local method="1"
    if [[ "${AUTO_MODE}" == "false" ]]; then
        echo -e "Select installation method:"
        echo -e "  1) Docker (Recommended)"
        echo -e "  2) Native (Ubuntu/Systemd)"
        echo ""
        method=$(ask "Choice" "1")
    fi

    case "$method" in
        1) install_docker ;;
        2) install_native ;;
        *) die "Invalid choice." ;;
    esac

    echo ""
    hr
    ok "Installation complete!"
    echo -e "Visit ${BOLD}http://localhost:${PORT:-8000}${NC} to finish setup."
    hr
}

main "$@"
