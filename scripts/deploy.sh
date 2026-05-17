#!/bin/bash
# Production Deployment Script
# This script handles the full deployment process with safety checks

set -e  # Exit on error
set -u  # Exit on undefined variable

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${PROJECT_DIR}/build/docker-compose.prod.yml"
ENV_FILE="${PROJECT_DIR}/build/.env"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if .env exists
check_env() {
    log_info "Checking environment configuration..."

    if [ ! -f "$ENV_FILE" ]; then
        log_error ".env file not found!"
        log_info "Copy .env.production.example to .env and configure it."
        exit 1
    fi

    # Source environment file
    set -a
    source "$ENV_FILE"
    set +a

    # Check required variables
    if [ -z "${SECRET_KEY:-}" ] || [ "$SECRET_KEY" = "CHANGE_THIS_TO_A_RANDOM_SECRET_KEY_64_CHARACTERS_OR_MORE" ]; then
        log_error "SECRET_KEY not configured!"
        log_info "Generate with: openssl rand -base64 48"
        exit 1
    fi

    if [ -z "${SESSION_SECRET:-}" ] || [ "$SESSION_SECRET" = "CHANGE_THIS_TO_A_DIFFERENT_RANDOM_SECRET_KEY" ]; then
        log_error "SESSION_SECRET not configured!"
        exit 1
    fi

    log_success "Environment configuration valid"
}

# Create backup before deployment
create_backup() {
    log_info "Creating pre-deployment backup..."

    BACKUP_DIR="${PROJECT_DIR}/data/backups"
    mkdir -p "$BACKUP_DIR"

    BACKUP_FILE="$BACKUP_DIR/pre-deploy-$(date +%Y-%m-%d_%H-%M-%S).tar.gz"

    if [ -f "${PROJECT_DIR}/data/point.db" ]; then
        tar -czf "$BACKUP_FILE" \
            -C "${PROJECT_DIR}/data" \
            point.db media/ 2>/dev/null || true

        log_success "Backup created: $BACKUP_FILE"
    else
        log_warning "No existing database found, skipping backup"
    fi
}

# Pull latest Docker image
pull_image() {
    log_info "Pulling latest Docker image..."

    docker compose -f "$COMPOSE_FILE" pull point

    log_success "Docker image pulled successfully"
}

# Run database migrations (if any)
run_migrations() {
    log_info "Running database migrations..."

    # Database initialization is handled by the application or requires manual step
    # docker compose -f "$COMPOSE_FILE" exec -T point ./point -migrate || true

    log_success "Database migrations skipped (handled by app)"
}

# Migrate legacy /media/originals/… paths in posts to the /YYYY/MM/… form
migrate_paths() {
    log_info "Migrating legacy media paths..."

    # Dry run first so we can see what would change
    log_info "Dry run preview:"
    docker compose -f "$COMPOSE_FILE" exec -T point \
        ./migrate-paths --db /data/point.db

    log_info "Applying path migration..."
    docker compose -f "$COMPOSE_FILE" exec -T point \
        ./migrate-paths --db /data/point.db --apply

    log_success "Path migration complete"
}

# Deploy new version
deploy() {
    log_info "Deploying new version..."

    # Start services
    docker compose -f "$COMPOSE_FILE" up -d point

    log_success "Services started"
}

# Wait for service to be healthy
wait_for_health() {
    log_info "Waiting for service to be healthy..."

    MAX_ATTEMPTS=30
    ATTEMPT=0

    while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
        if docker compose -f "$COMPOSE_FILE" exec -T point \
            curl -f -s http://localhost:8000/health > /dev/null 2>&1; then
            log_success "Service is healthy!"
            return 0
        fi

        ATTEMPT=$((ATTEMPT + 1))
        echo -n "."
        sleep 2
    done

    log_error "Service failed to become healthy after $MAX_ATTEMPTS attempts"
    return 1
}

# Run health checks
health_check() {
    log_info "Running health checks..."

    # Check if service responds
    if ! wait_for_health; then
        log_error "Health check failed!"
        return 1
    fi

    # Check database file existence
    if docker compose -f "$COMPOSE_FILE" exec -T point \
        ls /data/point.db >/dev/null 2>&1; then
        log_success "Database file exists"
    else
        log_warning "Database file check failed"
    fi

    return 0
}

# Cleanup old images
cleanup() {
    log_info "Cleaning up old Docker images..."

    docker image prune -f

    log_success "Cleanup completed"
}

# Rollback to previous version
rollback() {
    log_error "Deployment failed! Rolling back..."

    # Stop current version
    docker compose -f "$COMPOSE_FILE" down

    # Restore backup (if exists)
    LATEST_BACKUP=$(ls -t "${PROJECT_DIR}/data/backups"/pre-deploy-*.tar.gz 2>/dev/null | head -1)

    if [ -n "$LATEST_BACKUP" ]; then
        log_info "Restoring backup: $LATEST_BACKUP"
        tar -xzf "$LATEST_BACKUP" -C "${PROJECT_DIR}/data"
        log_success "Backup restored"
    fi

    # Start previous version
    docker compose -f "$COMPOSE_FILE" up -d point

    log_warning "Rollback completed. Please investigate the issue."
}

# Main deployment flow
main() {
    log_info "========================================="
    log_info "Point - Production Deployment"
    log_info "========================================="

    # Pre-deployment checks
    check_env

    # Create backup
    create_backup

    # Pull and deploy
    pull_image
    deploy

    # Post-deployment
    if health_check; then
        run_migrations
        cleanup

        log_success "========================================="
        log_success "Deployment completed successfully!"
        log_success "========================================="

        # Show service status
        docker compose -f "$COMPOSE_FILE" ps
    else
        rollback
        exit 1
    fi
}

# Handle script arguments
case "${1:-deploy}" in
    deploy)
        main
        ;;
    rollback)
        rollback
        ;;
    health)
        health_check
        ;;
    backup)
        create_backup
        ;;
    migrate-paths)
        migrate_paths
        ;;
    *)
        echo "Usage: $0 {deploy|rollback|health|backup|migrate-paths}"
        exit 1
        ;;
esac
