#!/bin/bash

# Test runner script
# Usage: ./tests.sh [file_or_folder] [options]
# If no parameter provided, tests entire tests/ directory
# Options:
#   --html          Generate HTML coverage report
#   --verbose       Show verbose output
#   --missing       Show missing lines in coverage report
#   --module=PATH   Coverage for specific module (e.g., --module=app.api.auth)

TARGET="${1:-tests/}"
COVERAGE_TARGET="app"
REPORT_TYPE="term"
QUIET="-q"
SHOW_MISSING=""

# Parse additional arguments
shift
while [[ $# -gt 0 ]]; do
    case $1 in
        --html)
            REPORT_TYPE="html"
            shift
            ;;
        --verbose)
            QUIET="-v"
            shift
            ;;
        --missing)
            SHOW_MISSING="--cov-report=term-missing"
            shift
            ;;
        --module=*)
            COVERAGE_TARGET="${1#*=}"
            shift
            ;;
        *)
            shift
            ;;
    esac
done

# Run pytest with coverage
if [ "$REPORT_TYPE" = "html" ]; then
    venv/bin/pytest "$TARGET" --cov="$COVERAGE_TARGET" --cov-report=html --cov-report=term $SHOW_MISSING $QUIET
    echo ""
    echo "HTML coverage report generated in htmlcov/index.html"
else
    venv/bin/pytest "$TARGET" --cov="$COVERAGE_TARGET" --cov-report=term $SHOW_MISSING $QUIET
fi
