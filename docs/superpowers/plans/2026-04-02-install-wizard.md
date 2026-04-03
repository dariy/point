# Install Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `quickstart/install.sh` — an interactive setup wizard that installs Point photo blog via Docker (default) or a native Linux binary, with all prompts having sensible defaults so hitting Enter on everything produces a running site.

**Architecture:** A single self-contained bash script that prompts for install method and config values (all with defaults), then either starts a Docker Compose stack or downloads a pre-built binary tarball from GitHub Releases and installs it as a systemd service. `QUICKSTART.md` gets a one-liner at the top. The CI pipeline binary publishing job is a prerequisite for the native path and is tracked as a follow-on deliverable (Task 1-opt, separate PR).

**Tech Stack:** Bash, Docker/Podman, systemd, GitHub Releases API

---

## Existing Files (no creation needed)

These files already exist in the repo and are used as-is by the wizard:

| File | Status | Notes |
|------|--------|-------|
| `quickstart/docker-compose.yml` | EXISTS | Downloaded by Docker path |
| `quickstart/.env.example` | EXISTS | Referenced in QUICKSTART.md manual steps |
| `quickstart/update.sh` | EXISTS | Referenced in success message |

## Notes on SECRET_KEY

The app auto-generates `SECRET_KEY` on first startup and persists it in `blog_settings` (implemented in commit `089e9a6`). No env var is required. `write_env_file` correctly omits it — the server handles generation.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `quickstart/install.sh` | Interactive setup wizard |
| Modify | `QUICKSTART.md` | Add one-liner curl install at top |
| Modify (opt) | `.github/workflows/release.yml` | Add native binary build job — separate PR, prerequisite for native path |

---

## Task 1: Script skeleton + helpers

Create the install.sh file with banner, color output helpers, the `ask()` prompt function, and main entry point. Everything else builds on top of this skeleton.

**Files:**
- Create: `quickstart/install.sh`

- [ ] **Step 1: Create the file with skeleton**

Create `quickstart/install.sh`:

```bash
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
```

- [ ] **Step 2: Make executable and syntax-check**

```bash
chmod +x quickstart/install.sh
bash -n quickstart/install.sh && echo "Syntax OK"
```

Expected: `Syntax OK`

- [ ] **Step 3: Verify --help works**

```bash
bash quickstart/install.sh --help
```

Expected output includes: `Usage: bash install.sh [--method=docker|native]`

- [ ] **Step 4: Commit**

```bash
git add quickstart/install.sh
git commit -m "feat: add install.sh wizard skeleton with helpers and arg parsing"
```

---

## Task 2: Install method selection + config collection

Replace the placeholder `pick_install_method` and `collect_config` functions with real prompts. All answers land in global variables that later tasks read.

**Files:**
- Modify: `quickstart/install.sh`

- [ ] **Step 1: Replace pick_install_method**

Find and replace the `pick_install_method()` placeholder in `quickstart/install.sh`:

```bash
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
```

- [ ] **Step 2: Replace collect_config**

Find and replace the `collect_config()` placeholder:

```bash
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

  PORT=$(maybe_ask "Port" "8000")

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
```

- [ ] **Step 3: Syntax-check**

```bash
bash -n quickstart/install.sh && echo "Syntax OK"
```

Expected: `Syntax OK`

- [ ] **Step 4: Smoke-test prompts in non-interactive mode**

```bash
bash quickstart/install.sh --non-interactive --method=docker 2>&1 | head -20
```

Expected: prints banner + config section, then hits "Not yet implemented" and exits 1 — that's fine for now.

- [ ] **Step 5: Commit**

```bash
git add quickstart/install.sh
git commit -m "feat: add method selection and config prompts to install wizard"
```

---

## Task 3: Docker install path

Replace the `install_via_docker` placeholder with the real implementation: check for Docker/Podman, offer to install Docker if absent (Ubuntu), download compose file, write `.env`, start the stack.

**Files:**
- Modify: `quickstart/install.sh`

- [ ] **Step 1: Add Docker engine detection + install helper**

Insert before the `install_via_docker` placeholder:

```bash
# ── Docker helpers ─────────────────────────────────────────────────────────────

# Sets COMPOSE global to "docker compose" or "podman compose"
detect_compose_engine() {
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
```

- [ ] **Step 2: Replace install_via_docker placeholder**

```bash
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
```

- [ ] **Step 3: Add write_env_file function**

Insert before `install_via_docker`:

```bash
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
```

- [ ] **Step 4: Syntax-check**

```bash
bash -n quickstart/install.sh && echo "Syntax OK"
```

Expected: `Syntax OK`

- [ ] **Step 5: Commit**

```bash
git add quickstart/install.sh
git commit -m "feat: implement Docker install path in install wizard"
```

---

## Task 4: Native install path

Replace the `install_native` placeholder. Downloads the binary tarball for the host's architecture from GitHub Releases, extracts to `/opt/point`, creates a dedicated system user, writes `.env`, creates and enables a systemd service.

**Files:**
- Modify: `quickstart/install.sh`

- [ ] **Step 1: Add arch detection + version fetch helpers**

Insert before the `install_native` placeholder:

```bash
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
  say "Downloading ${tarball}..."
  curl -fsSL "$url" -o "/tmp/${tarball}"
  ok "Downloaded to /tmp/${tarball}"
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
```

- [ ] **Step 2: Replace install_native placeholder**

```bash
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
```

- [ ] **Step 3: Syntax-check**

```bash
bash -n quickstart/install.sh && echo "Syntax OK"
```

Expected: `Syntax OK`

- [ ] **Step 4: Commit**

```bash
git add quickstart/install.sh
git commit -m "feat: implement native Linux binary install path in install wizard"
```

---

## Task 5: Health check + success message

Replace the `wait_for_health` and `show_success` placeholders so the script waits until Point is actually responding, then shows a friendly completion message with the URL.

**Files:**
- Modify: `quickstart/install.sh`

- [ ] **Step 1: Replace wait_for_health placeholder**

```bash
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
```

- [ ] **Step 2: Replace show_success placeholder**

```bash
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
```

- [ ] **Step 3: Syntax-check**

```bash
bash -n quickstart/install.sh && echo "Syntax OK"
```

Expected: `Syntax OK`

- [ ] **Step 4: End-to-end non-interactive dry run**

```bash
bash quickstart/install.sh --help
bash -n quickstart/install.sh
```

Both should exit 0 cleanly.

- [ ] **Step 5: Commit**

```bash
git add quickstart/install.sh
git commit -m "feat: add health check and success message to install wizard"
```

---

## Task 6: Update QUICKSTART.md

Add the one-liner curl install command at the top as the primary install path, then revise the 3-step section to reference `install.sh` instead of manual steps.

**Files:**
- Modify: `QUICKSTART.md`

- [ ] **Step 1: Read current QUICKSTART.md**

Read `QUICKSTART.md` to see the current structure before editing.

- [ ] **Step 2: Add one-liner section at the top**

After the introductory paragraph (before "## Requirements"), insert:

```markdown
## One-Command Install

```bash
curl -fsSL https://raw.githubusercontent.com/dariy/point/main/quickstart/install.sh | bash
```

The wizard will ask a few questions (all with sensible defaults — just hit Enter) and have Point running in minutes. See below for details and manual options.

---

```

- [ ] **Step 3: Update the 3-step section**

Replace the existing "## Install in 3 Steps" section:

```markdown
## Install in 3 Steps (manual)

If you prefer to run the steps yourself:

### Step 1: Download the files
```bash
mkdir point && cd point
curl -LO https://raw.githubusercontent.com/dariy/point/main/quickstart/docker-compose.yml
curl -LO https://raw.githubusercontent.com/dariy/point/main/quickstart/.env.example
cp .env.example .env
```

### Step 2: Start Point
```bash
docker compose up -d
```

### Step 3: First-run setup
Open `http://localhost:8000` in your browser. The setup wizard will appear — enter your username, password, and blog name to finish.
```

- [ ] **Step 4: Commit**

```bash
git add QUICKSTART.md
git commit -m "docs: add one-liner curl install to QUICKSTART.md"
```

---

## Self-Review

### Spec coverage check

| Requirement | Task |
|-------------|------|
| Shell script that works like setup wizard | Task 1 (skeleton), Tasks 2–5 (implementation) |
| Direct install on Linux (Ubuntu) | Task 4 (native path) |
| Docker install option | Task 3 (Docker path) |
| Set up environment file | Tasks 3 + 4 (write_env_file) |
| Happy path: hit Enter on everything → running site | Task 2 (all defaults), Task 5 (health check), `--non-interactive` flag |
| Pre-built binary (confirmed by user) | Task 4 downloads from GitHub Releases; CI publishing is Task 7 (optional) |

### Existing files already in repo (no creation needed)

- `quickstart/docker-compose.yml` — downloaded by the Docker path; already exists (verified)
- `quickstart/.env.example` — referenced in QUICKSTART.md manual steps; already exists (verified — 20 lines)
- `quickstart/update.sh` — downloaded to `$INSTALL_DIR` by `install_via_docker` and referenced in success message; already exists (verified)
- `SECRET_KEY` — intentionally absent from `.env`; the app auto-generates it on first startup (commit `089e9a6`, `api/cmd/api/main.go:46–78`)
- `/health` endpoint — confirmed at `api/cmd/api/main.go:169`; used by `wait_for_health` and docker-compose healthcheck
- **PORT in Docker** — `docker-compose.yml:18` hardcodes `PORT=8000` in the `environment:` block, which takes precedence over `env_file`. The wizard does not prompt for PORT in Docker mode; it announces "uses port 8000" and the health check and success URL both use port 8000.
- **esbuild in CI (Task 7)** — `build/Dockerfile:37-39` confirms esbuild is used for production builds. CLAUDE.md's "no build step" refers to the dev workflow only (changes to JS are live without rebuilding). The CI tarball job legitimately replicates the Dockerfile's esbuild step.

### Gap: CI must publish before native path works

The native path downloads from GitHub Releases. A tagged release with binary tarballs must exist (published by Task 7-opt). The wizard fails gracefully with a clear error if no release is available (`fetch_latest_version` dies with a helpful message). Task 7 is a follow-on PR, not a blocker for the wizard itself.

### Placeholder scan

No TBD/TODO items. All functions have complete implementations across tasks. Function names are consistent: `install_native`, `install_via_docker`, `collect_config`, `pick_install_method`, `wait_for_health`, `show_success`, `write_env_file`.

### Type consistency

Global variables set in `collect_config` (`PORT`, `DATA_DIR`, `GEMINI_KEY`, `PHOTO_LIB_PATH`, `INSTALL_DIR`, `INSTALL_METHOD`) are used consistently in Tasks 3, 4, 5. `COMPOSE` is set by `detect_compose_engine` and used in `install_via_docker`. `POINT_VERSION` is set by `fetch_latest_version` and used in `download_tarball`.

---

## Task 7 (Optional — follow-on PR): Add native binary CI job to release.yml

> **Prerequisite for native install path.** The native path in Task 4 downloads a pre-built tarball from GitHub Releases. Without this CI job, no tarball exists and the native path will fail with a clear error message. Implement this as a separate PR after the wizard lands.

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Open the release workflow**

Read `.github/workflows/release.yml`. Confirm it ends at the `build-and-push` job that pushes Docker images to GHCR.

- [ ] **Step 2: Append the native build job**

Add the following job to `.github/workflows/release.yml` after the existing `build-and-push` job:

```yaml
  build-native:
    runs-on: ubuntu-latest
    if: startsWith(github.ref, 'refs/tags/v')
    permissions:
      contents: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version-file: api/go.mod
          cache-dependency-path: api/go.sum

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Build frontend assets
        run: |
          cd api
          npx --yes esbuild ../frontend/src/app.js \
            --bundle --minify --format=esm \
            --outfile=../frontend/js/app.js
          cd ..
          bash scripts/build-css.sh

      - name: Stamp build version into index.html
        run: |
          VERSION="${{ github.ref_name }}"
          sed -i "s/__BUILD_VERSION__/${VERSION}/g" frontend/index.html

      - name: Build binaries
        run: |
          cd api
          for ARCH in amd64 arm64; do
            CGO_ENABLED=0 GOOS=linux GOARCH=$ARCH go build \
              -ldflags="-s -w" \
              -o ../point-linux-$ARCH \
              ./cmd/api/main.go
          done

      - name: Package tarballs
        run: |
          for ARCH in amd64 arm64; do
            PKG=point-linux-$ARCH
            mkdir -p dist/$PKG
            cp point-linux-$ARCH    dist/$PKG/point
            cp -r frontend/          dist/$PKG/frontend/
            cp api/data.yml          dist/$PKG/data.yml
            tar -czf ${PKG}.tar.gz -C dist $PKG
            sha256sum ${PKG}.tar.gz > ${PKG}.tar.gz.sha256
          done

      - name: Upload release assets
        uses: softprops/action-gh-release@v2
        with:
          files: |
            point-linux-amd64.tar.gz
            point-linux-amd64.tar.gz.sha256
            point-linux-arm64.tar.gz
            point-linux-arm64.tar.gz.sha256
```

- [ ] **Step 3: Verify YAML syntax**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo "YAML OK"
```

Expected: `YAML OK`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: build native Linux tarballs on tagged releases"
```
