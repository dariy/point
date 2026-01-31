#!/bin/bash

# Test runner script
# Usage: ./tests.sh [file_or_folder]
# If no parameter provided, tests entire tests/ directory

TARGET="${1:-tests/}"

venv/bin/pytest "$TARGET" --cov=app --cov-report=term -q
