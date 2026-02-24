# Utility Scripts

This directory contains scripts for managing backups, deployment, and testing of the Point application.

## Core Scripts

- **deploy.sh**: Production deployment script with safety checks and auto-rollback.
- **setup-production.sh**: Prepares a fresh server for Point deployment (installs Docker, sets up users, firewall, etc.).
- **run-tests.sh**: Go test runner with coverage reporting support.
- **build-css.sh**: Concatenates CSS modules into bundle files (`main.css` and `light.css`).
- **backup.sh**: Unified backup and restore management script.

## Backup & Restore Management (`backup.sh`)

The `backup.sh` script replaces several legacy scripts with a single command-line interface.

### Usage

```bash
./scripts/backup.sh [command] [args]
```

### Commands

| Command | Description |
|---------|-------------|
| `create` | Create a backup from the local container and save it to `./backups/` |
| `restore [file]` | Restore a backup file to the local container |
| `pull` | Pull the latest backup from the production server to the local machine |
| `push [file]` | Push a local backup file to the production server and restore it there |
| `test` | Test SSH and Docker access to the production server |

### Configuration

Copy `scripts/backup-config.sh.example` to `scripts/backup-config.sh` and adjust the variables to match your production environment.

## Deployment Workflow

1.  **Setup**: Run `setup-production.sh` on a fresh server.
2.  **Configuration**: Set up `.env` and `backup-config.sh`.
3.  **Deploy**: Run `deploy.sh` to pull images and start services.
4.  **Maintenance**: Use `backup.sh` for data synchronization between local and production.

## Development

Use `build/rebuild.sh` for local development. it will automatically call `scripts/build-css.sh` and rebuild the container image.
