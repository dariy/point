# Development Dockerfile (requires binary to be built on host)
FROM alpine:3.19

# Install runtime dependencies
RUN apk add --no-cache \
    sqlite-libs \
    ca-certificates \
    tzdata \
    curl \
    wget \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# Copy the binary (must be built on host or by some script)
# Use build/api-bin as the expected location
COPY build/api-bin .

# Copy frontend assets
COPY frontend/ /app/frontend/

# Create data directory structure
RUN mkdir -p /data/media/originals \
    /data/media/thumbnails \
    /data/logs \
    /data/backups

# Accept build version as argument
ARG BUILD_VERSION=dev
ENV APP_VERSION=${BUILD_VERSION}
ENV DATABASE_URL=/data/point.db
ENV STORAGE_PATH=/data
ENV HOST=0.0.0.0
ENV PORT=8000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:8000/health || exit 1

# Non-root user
RUN adduser -D -u 1000 appuser && \
    chown -R appuser:appuser /app /data
USER appuser

EXPOSE 8000

CMD ["./api-bin"]
