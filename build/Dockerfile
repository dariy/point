# Build stage
FROM --platform=$BUILDPLATFORM docker.io/library/golang:alpine AS builder
ARG TARGETOS
ARG TARGETARCH

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
    -ldflags="-s -w" \
    -o api-bin cmd/api/main.go

# Build the path migration utility
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build \
    -ldflags="-s -w" \
    -o migrate-paths cmd/migrate-paths/main.go

# Bundle and minify frontend JS
COPY frontend/ ./frontend/
RUN npx --yes esbuild frontend/src/app.js \
    --bundle --minify --format=esm \
    --outfile=frontend/js/app.js

# Bundle CSS modules into main.css (public) and light.css (admin)
COPY scripts/build-css.sh ./scripts/
RUN sh ./scripts/build-css.sh

# Runtime stage
FROM docker.io/library/alpine:latest

WORKDIR /app

# Install only necessary runtime dependencies and create user in one layer
RUN apk add --no-cache \
    ca-certificates \
    tzdata \
    curl \
    && adduser -D -u 1000 appuser \
    && mkdir -p /data/media/originals /data/media/thumbnails /data/logs /data/backups \
    && chown -R appuser:appuser /app /data

# Copy the binaries from the builder stage
COPY --from=builder /app/api-bin .
COPY --from=builder /app/migrate-paths .
# Copy data.yml
COPY --from=builder /app/data.yml .
# Copy frontend assets (includes built js/ bundle from builder stage)
COPY --from=builder /app/frontend/ /app/frontend/

# Accept build version as argument and stamp it into index.html for cache-busting
ARG BUILD_VERSION=dev
RUN sed -i "s/__BUILD_VERSION__/${BUILD_VERSION}/g" /app/frontend/index.html
ENV APP_VERSION=${BUILD_VERSION}
ENV DATABASE_URL=/data/point.db
ENV STORAGE_PATH=/data
ENV FRONTEND_DIR=/app/frontend
ENV HOST=0.0.0.0
ENV PORT=8000

USER appuser

EXPOSE 8000

# Health check using curl (already installed)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PORT:-8000}/health || exit 1

CMD ["./api-bin"]
