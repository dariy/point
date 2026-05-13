#!/bin/bash
# Deploy a locally-built podman image to a remote host via scp, then run podman compose there.
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration — override via environment or edit these defaults.
# ---------------------------------------------------------------------------
IMAGE_NAME="${IMAGE_NAME:-point}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
# Full image name the compose file references (may differ from local build tag).
# podman treats "point" and "localhost/point" as the same; set this if compose
# uses a different name (e.g. ghcr.io/org/point).
COMPOSE_IMAGE="${COMPOSE_IMAGE:-localhost/point}"

DEST_HOST="${DEST_HOST:-}"            # e.g. user@myserver.example.com
DEST_PATH="${DEST_PATH:-/home/opc/darii.net}"  # remote directory with compose file

ARCHIVE_NAME="${IMAGE_NAME}-${IMAGE_TAG}.tar"
ARCHIVE_PATH="/tmp/${ARCHIVE_NAME}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
die() { echo "ERROR: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "'$1' not found — please install it."
}

# ---------------------------------------------------------------------------
# Argument / env validation
# ---------------------------------------------------------------------------
if [[ -z "$DEST_HOST" ]]; then
    echo "Usage: DEST_HOST=user@host [IMAGE_NAME=point] [IMAGE_TAG=latest] [DEST_PATH=~/point] $0"
    echo
    echo "Environment variables:"
    echo "  DEST_HOST    (required)  SSH destination, e.g. deploy@myserver.com"
    echo "  DEST_PATH    (optional)  Remote path where compose file lives  [~/point]"
    echo "  IMAGE_NAME   (optional)  Image name to build/export             [point]"
    echo "  IMAGE_TAG    (optional)  Image tag                              [latest]"
    echo "  COMPOSE_FILE (optional)  Compose filename on the remote host    [docker-compose.prod.yml]"
    exit 1
fi

PLATFORM="${PLATFORM:-linux/arm64}"

require_cmd podman
require_cmd ssh

# ---------------------------------------------------------------------------
# 1. Build the image locally
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"

step "Building image ${IMAGE_NAME}:${IMAGE_TAG} from $BUILD_DIR/Dockerfile (platform: $PLATFORM)"

# Cross-platform builds need QEMU binfmt handlers registered in the kernel.
LOCAL_ARCH="$(uname -m)"
TARGET_ARCH="${PLATFORM##*/}"  # arm64 from linux/arm64
# OCI uses "arm64"; the kernel binfmt entry uses the kernel name "aarch64"
BINFMT_ARCH="$TARGET_ARCH"
[[ "$BINFMT_ARCH" == "arm64" ]] && BINFMT_ARCH="aarch64"
BINFMT_NAME="qemu-${BINFMT_ARCH}"
if [[ "$LOCAL_ARCH" == "x86_64" && "$TARGET_ARCH" == "arm64" ]]; then
    if [[ ! -f "/proc/sys/fs/binfmt_misc/${BINFMT_NAME}" ]]; then
        die "Cross-platform build for $PLATFORM requires QEMU binfmt handlers.
  Fix: sudo podman run --rm --privileged docker.io/multiarch/qemu-user-static --reset -p yes
  Or:  sudo dnf install qemu-user-static && sudo systemctl restart systemd-binfmt"
    fi
fi

podman build \
    --tag "${IMAGE_NAME}:${IMAGE_TAG}" \
    --file "$BUILD_DIR/Dockerfile" \
    --platform "$PLATFORM" \
    "$SCRIPT_DIR"

# ---------------------------------------------------------------------------
# 2. Export the image to a tar archive
# ---------------------------------------------------------------------------
step "Exporting image to $ARCHIVE_PATH"
podman save --output "$ARCHIVE_PATH" "${IMAGE_NAME}:${IMAGE_TAG}"
echo "Archive size: $(du -sh "$ARCHIVE_PATH" | cut -f1)"

# ---------------------------------------------------------------------------
# 3. Upload archive to remote host
# ---------------------------------------------------------------------------
step "Uploading $ARCHIVE_PATH → ${DEST_HOST}:${DEST_PATH}/"
# Pipe through ssh stdin instead of scp — avoids "message too long" errors when
# the remote shell prints output (neofetch, motd, etc.) in non-interactive sessions.
ssh "$DEST_HOST" "mkdir -p ${DEST_PATH} && cat > ${DEST_PATH}/${ARCHIVE_NAME}" < "$ARCHIVE_PATH"

# ---------------------------------------------------------------------------
# 4. Load image into remote podman, then bring compose stack up
# ---------------------------------------------------------------------------
step "Loading image and restarting compose stack on $DEST_HOST"
ssh "$DEST_HOST" bash -s <<REMOTE
set -euo pipefail
cd "${DEST_PATH}"

echo "[remote] Loading image..."
podman load --input "${DEST_PATH}/${ARCHIVE_NAME}"

# Compose file references the registry name; tag the loaded image to match so
# podman compose uses it instead of pulling from the registry.
if [[ "${IMAGE_NAME}:${IMAGE_TAG}" != "${COMPOSE_IMAGE}:${IMAGE_TAG}" ]]; then
    echo "[remote] Tagging ${IMAGE_NAME}:${IMAGE_TAG} → ${COMPOSE_IMAGE}:${IMAGE_TAG}"
    podman tag "${IMAGE_NAME}:${IMAGE_TAG}" "${COMPOSE_IMAGE}:${IMAGE_TAG}"
fi

echo "[remote] Removing archive..."
rm -f "${DEST_PATH}/${ARCHIVE_NAME}"

echo "[remote] Stopping and removing old containers to force recreation with new image..."
podman compose -f "${COMPOSE_FILE}" down --remove-orphans 2>/dev/null || true

echo "[remote] Running podman compose up -d..."
podman compose -f "${COMPOSE_FILE}" up -d

echo "[remote] Done. Running containers:"
podman ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
REMOTE

# ---------------------------------------------------------------------------
# 5. Cleanup local archive
# ---------------------------------------------------------------------------
step "Cleaning up local archive"
rm -f "$ARCHIVE_PATH"

echo
echo "Deployment complete: ${IMAGE_NAME}:${IMAGE_TAG} → ${DEST_HOST}:${DEST_PATH}"
