# Build stage
FROM python:3.12-slim as builder

WORKDIR /build

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libc6-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and build wheels
COPY requirements.txt .
RUN pip wheel --no-cache-dir --wheel-dir /wheels -r requirements.txt

# Runtime stage
FROM python:3.12-slim

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Copy and install Python packages from wheels
COPY --from=builder /wheels /wheels
RUN pip install --no-cache-dir --no-deps /wheels/* && rm -rf /wheels

# Create data directory structure and user
RUN useradd -m -u 1000 appuser && \
    mkdir -p /data/media/originals \
    /data/media/thumbnails \
    /data/media/avatars \
    /data/cache/pages \
    /data/cache/feeds \
    /data/cache/fragments \
    /data/logs \
    /data/backups \
    /data/config && \
    chown -R appuser:appuser /app /data

# Health check (common for both base and dev)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1
