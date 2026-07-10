# Remark42 comment engine (build with --pull so :latest refreshes; pin via arg if a release breaks)
ARG REMARK42_VERSION=latest
FROM ghcr.io/umputun/remark42:${REMARK42_VERSION} AS remark42

# Build stage
FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.26.5-alpine3.23 AS builder
ARG TARGETOS
ARG TARGETARCH
ARG BUILD_VERSION=dev

# Install build dependencies
RUN apk add --no-cache git nodejs npm

WORKDIR /app

# Copy go mod and sum files
COPY api/go.mod api/go.sum ./
# Use cache mount for go modules
RUN --mount=type=cache,target=/go/pkg/mod go mod download

# Copy the source code
COPY api/ ./

# Build the application - stripped and optimized
# Using cache mounts for both modules and build cache
# Removing -a flag to enable incremental builds
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build \
    -ldflags="-s -w -X main.Version=${BUILD_VERSION}" \
    -o point ./cmd/api

# Build the path migration utility
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build \
    -ldflags="-s -w" \
    -o migrate-paths ./cmd/migrate-paths

# Bundle and minify frontend JS (release build — __DEBUG__=false strips the
# debug logging in utils/debug.js). The debug bundle (frontend/js-debug) is a
# dev convenience produced by scripts/build-js.sh and is not shipped here.
COPY scripts/ ./scripts/
COPY frontend/ ./frontend/
RUN sh ./scripts/build-js.sh

# Bundle CSS modules into main.css (public) and light.css (admin)
RUN sh ./scripts/build-css.sh

# Runtime stage
FROM docker.io/library/alpine:3.24

WORKDIR /app

# Install only necessary runtime dependencies and create user in one layer
RUN apk add --no-cache \
    ca-certificates \
    tzdata \
    curl \
    su-exec \
    && adduser -D -u 1000 appuser \
    && mkdir -p /data/media/originals /data/media/thumbnails /data/logs /data/backups /data/themes \
    && chown -R appuser:appuser /app /data

# Copy the binaries from the builder stage
COPY --chown=appuser:appuser --from=builder /app/point .
COPY --chown=appuser:appuser --from=builder /app/migrate-paths .
# Copy data.yml
COPY --chown=appuser:appuser --from=builder /app/data.yml .
# Copy frontend assets (includes built js/ bundle from builder stage)
COPY --chown=appuser:appuser --from=builder /app/frontend/ /app/frontend/

# Remark42 binary + web assets (started by entrypoint.sh when REMARK_SECRET/REMARK_URL are set)
COPY --chown=appuser:appuser --from=remark42 /srv /app/remark42

# Accept build version as argument and stamp it into index.html for cache-busting
ARG BUILD_VERSION=dev
RUN sed -i "s/__BUILD_VERSION__/${BUILD_VERSION}/g" /app/frontend/index.html
ENV APP_VERSION=${BUILD_VERSION}
ENV DATABASE_URL=/data/point.db
ENV STORAGE_PATH=/data
ENV FRONTEND_DIR=/app/frontend
ENV HOST=0.0.0.0
ENV PORT=8000

COPY scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8000

# Health check using curl (already installed)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PORT:-8000}/health || exit 1

# Start as root so the entrypoint can create /data subdirs on volume mounts,
# then drop to appuser via su-exec before exec'ing the binary.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["./point"]
