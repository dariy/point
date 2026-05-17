# Utility Scripts

This directory contains scripts for development, testing, and building the Point application.

## Core Scripts

- **rebuild.sh**: Local development script to build and run the application container.
- **run-tests.sh**: Go test runner with coverage reporting support.
- **build-css.sh**: Concatenates CSS modules into bundle files (`main.css` and `light.css`).
- **build-js.sh**: Handles JS minification and bundling.
- **lint.sh**: Runs linters for code quality checks.

## Development Workflow

Use `scripts/rebuild.sh` for local development. It will automatically call `scripts/build-css.sh` and rebuild the container image using the `build/Dockerfile`.

Testing is handled via `scripts/run-tests.sh` which runs the full Go test suite.

## Deployment

Deployment configuration and orchestration has been moved to the [point-hosting](https://github.com/dariy/point-hosting) repository (or local `~/src/point-hosting`). The `point` repository is now focused on development, testing, and producing the Docker image.
