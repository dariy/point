#!/usr/bin/env bash
# Package the self-contained linux tarballs that quickstart/install.sh
# downloads for --method=native.
#
# install.sh dictates the shape, not this script: it fetches
# point-linux-${arch}.tar.gz from the GitHub Release for the latest tag,
# extracts it into /tmp, and copies /tmp/point-linux-${arch}/. into the install
# directory. So the archive must contain exactly one top-level directory named
# point-linux-${arch}, and everything inside it has to be what the systemd unit
# install.sh writes expects to find:
#
#   point           the server        (ExecStart=${INSTALL_DIR}/point)
#   frontend/       static assets     (FRONTEND_DIR=${INSTALL_DIR}/frontend)
#   data.yml        Gemini prompt/model config, read from the working directory
#                   (tracked as api/data.yml; only run.sh puts a copy at the root)
#   migrate-paths   the storage-path migration utility, as in the image
#   LICENSE
#
# The frontend bundles (frontend/js, frontend/css/main.css) are build outputs
# and are gitignored, so they are built here unless --skip-frontend says they
# are already in place. The debug bundle is deliberately left out, matching
# BUILD_DEBUG_FRONTEND=0 in build/Dockerfile.
#
# Usage: ./scripts/build-tarball.sh [--arch=amd64|arm64] [--version=vX.Y.Z]
#                                   [--out=DIR] [--skip-frontend]
#   --arch          repeatable; default builds both amd64 and arm64
#   --version       stamped into the binary as main.Version; defaults to the
#                   tag on HEAD, else `git describe`, else "dev"
#   --out           output directory (default: dist/)
#   --skip-frontend reuse the frontend bundles already on disk
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ARCHES=()
VERSION=""
OUT_DIR="$ROOT_DIR/dist"
SKIP_FRONTEND=0

for arg in "$@"; do
    case "$arg" in
        --arch=*)       ARCHES+=("${arg#*=}") ;;
        --version=*)    VERSION="${arg#*=}" ;;
        --out=*)        OUT_DIR="${arg#*=}" ;;
        --skip-frontend) SKIP_FRONTEND=1 ;;
        -h|--help)      sed -n '2,30p' "$0"; exit 0 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

[ ${#ARCHES[@]} -gt 0 ] || ARCHES=(amd64 arm64)
for arch in "${ARCHES[@]}"; do
    case "$arch" in
        amd64|arm64) ;;
        *) echo "unsupported arch: $arch (install.sh only resolves amd64 and arm64)" >&2; exit 2 ;;
    esac
done

if [ -z "$VERSION" ]; then
    VERSION="$(git -C "$ROOT_DIR" tag --points-at HEAD 2>/dev/null | grep '^v[0-9]' | head -1 || true)"
fi
if [ -z "$VERSION" ]; then
    VERSION="$(git -C "$ROOT_DIR" describe --tags --always --dirty 2>/dev/null || echo dev)"
fi

command -v go >/dev/null 2>&1 || { echo "go not found in PATH" >&2; exit 1; }

echo "Packaging Point ${VERSION} for: ${ARCHES[*]}"

if [ "$SKIP_FRONTEND" -eq 0 ]; then
    BUILD_DEBUG_FRONTEND=0 sh "$ROOT_DIR/scripts/build-js.sh"
    sh "$ROOT_DIR/scripts/build-css.sh"
fi

# A tarball missing the bundles installs a server that serves a blank page, and
# nothing downstream would notice until a user opened the site.
for required in frontend/js/app.js frontend/css/main.css frontend/css/light.css; do
    [ -f "$ROOT_DIR/$required" ] || {
        echo "missing build output: $required (drop --skip-frontend)" >&2
        exit 1
    }
done

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

for arch in "${ARCHES[@]}"; do
    name="point-linux-${arch}"
    stage="$OUT_DIR/$name"
    rm -rf "$stage"
    mkdir -p "$stage"

    echo "▶ building ${name}/point"
    (cd "$ROOT_DIR/api" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build \
        -trimpath -ldflags="-s -w -X main.Version=${VERSION}" \
        -o "$stage/point" ./cmd/api)

    echo "▶ building ${name}/migrate-paths"
    (cd "$ROOT_DIR/api" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build \
        -trimpath -ldflags="-s -w" \
        -o "$stage/migrate-paths" ./cmd/migrate-paths)

    cp "$ROOT_DIR/api/data.yml" "$ROOT_DIR/LICENSE" "$stage/"
    cp -r "$ROOT_DIR/frontend" "$stage/frontend"
    rm -rf "$stage/frontend/js-debug"

    tar -czf "$OUT_DIR/${name}.tar.gz" -C "$OUT_DIR" "$name"
    rm -rf "$stage"
    echo "✓ $OUT_DIR/${name}.tar.gz ($(du -h "$OUT_DIR/${name}.tar.gz" | cut -f1))"
done

(cd "$OUT_DIR" && sha256sum point-linux-*.tar.gz > checksums.txt)
echo "✓ $OUT_DIR/checksums.txt"
