#!/bin/bash
# Health Check Script
# Verifies that all services are running correctly

set -e

# Configuration
HEALTH_URL="${HEALTH_URL:-http://localhost:8000/health}"
TIMEOUT="${TIMEOUT:-10}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

check_http() {
    echo -n "Checking HTTP endpoint... "

    if curl -f -s -m "$TIMEOUT" "$HEALTH_URL" > /dev/null; then
        echo -e "${GREEN}OK${NC}"
        return 0
    else
        echo -e "${RED}FAILED${NC}"
        return 1
    fi
}

check_docker() {
    echo -n "Checking Docker containers... "

    if docker-compose -f docker-compose.prod.yml ps | grep -q "Up"; then
        echo -e "${GREEN}OK${NC}"
        return 0
    else
        echo -e "${RED}FAILED${NC}"
        return 1
    fi
}

check_database() {
    echo -n "Checking database... "

    if [ -f "data/point.db" ]; then
        echo -e "${GREEN}OK${NC}"
        return 0
    else
        echo -e "${RED}FAILED${NC}"
        return 1
    fi
}

check_disk_space() {
    echo -n "Checking disk space... "

    USAGE=$(df -h /var/lib/photo-blog/data | awk 'NR==2 {print $5}' | sed 's/%//')

    if [ "$USAGE" -lt 90 ]; then
        echo -e "${GREEN}OK${NC} (${USAGE}% used)"
        return 0
    else
        echo -e "${YELLOW}WARNING${NC} (${USAGE}% used)"
        return 1
    fi
}

main() {
    echo "========================================="
    echo "Photo Blog - Health Check"
    echo "========================================="

    FAILED=0

    check_docker || FAILED=$((FAILED + 1))
    check_database || FAILED=$((FAILED + 1))
    check_http || FAILED=$((FAILED + 1))
    check_disk_space || FAILED=$((FAILED + 1))

    echo "========================================="

    if [ $FAILED -eq 0 ]; then
        echo -e "${GREEN}All checks passed!${NC}"
        exit 0
    else
        echo -e "${RED}$FAILED check(s) failed!${NC}"
        exit 1
    fi
}

main
