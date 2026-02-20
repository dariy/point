#!/bin/bash

# Change to project root relative to script location
cd "$(dirname "$0")/.."

# Go Test runner script
# Usage: ./scripts/tests-go.sh [package_path] [options]
# If no parameter provided, tests all Go packages in go-api/
# Options:
#   --html          Generate HTML coverage report
#   --verbose       Show verbose output
#   --race          Enable race detector
#   --short         Skip long running tests
#   --bench         Run benchmarks

TARGET="./..."
if [[ $# -gt 0 && ! "$1" =~ ^- ]]; then
    TARGET="$1"
    shift
fi

# If TARGET doesn't start with . or /, assume it's relative to go-api
if [[ ! "$TARGET" =~ ^(\.|\/) ]]; then
    TARGET="./$TARGET"
fi

REPORT_TYPE="term"
VERBOSE=""
RACE=""
SHORT=""
BENCH=""

# Parse additional arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --html)
            REPORT_TYPE="html"
            shift
            ;;
        --verbose)
            VERBOSE="-v"
            shift
            ;;
        --race)
            RACE="-race"
            shift
            ;;
        --short)
            SHORT="-short"
            shift
            ;;
        --bench)
            BENCH="-bench=."
            shift
            ;;
        *)
            # If it's not a known option, it might be the target if TARGET was already set
            # but we'll just ignore unknown flags for now to stay simple
            shift
            ;;
    esac
done

# Ensure we are in the go-api directory for running tests
cd go-api

# Run go test with coverage
if [ "$REPORT_TYPE" = "html" ]; then
    go test $VERBOSE $RACE $SHORT $BENCH -coverprofile=coverage.out "$TARGET"
    go tool cover -html=coverage.out -o coverage.html
    echo ""
    echo "HTML coverage report generated in go-api/coverage.html"
    # Also show summary in terminal
    go tool cover -func=coverage.out
else
    go test $VERBOSE $RACE $SHORT $BENCH -cover "$TARGET"
fi
