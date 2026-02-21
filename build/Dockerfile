# Build stage
FROM golang:alpine AS builder

# Install build dependencies
RUN apk add --no-cache gcc musl-dev git

WORKDIR /app

# Copy go mod and sum files
COPY go-api/go.mod go-api/go.sum ./
RUN go mod download

# Copy the source code
COPY go-api/ ./

# Build the application - stripped and optimized
RUN CGO_ENABLED=1 GOOS=linux go build \
    -ldflags="-s -w" \
    -a -installsuffix cgo \
    -o api-bin cmd/api/main.go

# Runtime stage
FROM alpine:latest

WORKDIR /app

# Install only necessary runtime dependencies and create user in one layer
RUN apk add --no-cache \
    ca-certificates \
    sqlite-libs \
    tzdata \
    curl \
    && adduser -D -u 1000 appuser \
    && mkdir -p /data/media/originals /data/media/thumbnails /data/logs /data/backups \
    && chown -R appuser:appuser /app /data

# Copy the binary from the builder stage
COPY --from=builder /app/api-bin .
# Copy data.yml
COPY --from=builder /app/data.yml .
# Copy frontend assets
COPY frontend/ /app/frontend/

# Accept build version as argument
ARG BUILD_VERSION=dev
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
    CMD curl -f http://localhost:8000/health || exit 1

CMD ["./api-bin"]
