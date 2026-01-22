# Build stage
FROM python:3.12-slim as builder

WORKDIR /build

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libc6-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

# Runtime stage
FROM python:3.12-slim

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Copy Python packages from builder to a shared location
COPY --from=builder /root/.local /usr/local
ENV PATH=/usr/local/bin:$PATH

# Copy application
COPY app/ /app/app/
COPY scripts/ /app/scripts/

# Create data directory structure
RUN mkdir -p /data/media/originals \
    /data/media/thumbnails \
    /data/media/avatars \
    /data/cache/pages \
    /data/cache/feeds \
    /data/cache/fragments \
    /data/logs \
    /data/backups \
    /data/config

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Non-root user
RUN useradd -m -u 1000 appuser && \
    chown -R appuser:appuser /app /data
USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
