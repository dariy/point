# Backup & Restore Scripts

This directory contains scripts for managing backups of the Photo Blog application.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Backup Pipeline                         │
└─────────────────────────────────────────────────────────────────┘

    PRODUCTION SERVER              LOCAL
    ┌──────────────┐              ┌──────────────┐
    │  Docker      │              │  Docker      │
    │  Container   │              │  Container   │
    │  ┌────────┐  │              │  ┌────────┐  │
    │  │ /data  │  │              │  │ /data  │  │
    │  └────────┘  │              │  └────────┘  │
    └──────────────┘              └──────────────┘
           │                             │
           │ pull-from-production.sh     │ backup-from-local.sh
           │                             │
           └──────────┐         ┌────────┘
                      │         │
                      ▼         ▼
              ┌─────────────────────────┐
              │  ./backups/             │
              │  ├─ backup_*_pulled.gz  │  ← from production
              │  └─ backup_*_local.gz   │  ← from local
              └─────────────────────────┘
                      │         │
           ┌──────────┘         └────────┐
           │                             │
           │ push-to-production.sh       │ restore-to-local.sh
           │                             │
           ▼                             ▼
    ┌──────────────┐              ┌──────────────┐
    │  Production  │              │    Local     │
    │   Restored   │              │   Restored   │
    └──────────────┘              └──────────────┘
```

## Scripts Overview

### Legacy Backup Scripts (File-based)

- **backup.sh** - Create a local backup from data directory (database + media files)
- **restore.sh** - Restore to data directory from a local backup file

### Local Container Backup Scripts

- **backup-from-local.sh** - Create backup from local Docker container (auto-detects docker/podman)
- **restore-to-local.sh** - Restore backup to local Docker container (auto-detects docker/podman)

### Production Backup Scripts

- **pull-from-production.sh** - Pull latest backup from production to lab
- **push-to-production.sh** - Push backup to production and restore it

## Setup

### 1. Configure Production Access

Copy the example config file and edit it:

```bash
cp scripts/backup-config.sh.example scripts/backup-config.sh
nano scripts/backup-config.sh
```

Set the following variables:

**Production Server:**
- `PROD_HOST` - SSH connection to production (e.g., `user@192.168.1.100`)
- `PROD_CONTAINER` - Container name on production (default: `point-prod`)
- `PROD_SUDO` - Set to "sudo" if docker requires root (default: empty)

**Local Container:**
- `LOCAL_CONTAINER` - Container name on lab machine (default: `point`)
- `LOCAL_SUDO` - Set to "sudo" if docker requires root (default: empty)

**Storage:**
- `LOCAL_BACKUP_DIR` - Local backup directory on lab (default: `./backups`)

### 2. Setup Production Server

Docker commands require root privileges. Choose one option:

**Option A: Add user to docker group (simple)**
```bash
# On production server
sudo usermod -aG docker $USER
# Log out and back in
```

**Option B: Configure passwordless sudo (more secure)**
```bash
# On production server
sudo visudo -f /etc/sudoers.d/docker-backup
# Add specific docker commands (see SETUP-PRODUCTION.md)
```

Then set in `backup-config.sh`:
```bash
export PROD_SUDO=""        # If using Option A
export PROD_SUDO="sudo"    # If using Option B
```

📖 **See [SETUP-PRODUCTION.md](./SETUP-PRODUCTION.md) for detailed setup instructions**

### 3. Test Your Configuration

Verify everything is set up correctly:

```bash
source scripts/backup-config.sh
./scripts/test-production-access.sh
```

This will test:
- SSH connection
- Docker access
- Container existence
- Exec permissions
- Backup directory

### 4. Setup SSH Key Authentication

For passwordless operation, set up SSH keys:

```bash
# Generate SSH key if you don't have one
ssh-keygen -t ed25519 -C "your_email@example.com"

# Copy to production server
ssh-copy-id user@production-server.com
```

## Usage

### Backup from Local Container

Create a backup from your local Docker container:

```bash
# Option 1: Use default settings
./scripts/backup-from-local.sh

# Option 2: Use config file
source scripts/backup-config.sh
./scripts/backup-from-local.sh

# Option 3: Set variables inline
LOCAL_CONTAINER=point ./scripts/backup-from-local.sh
```

This will:
1. Auto-detect docker or podman
2. Check container is running
3. Create backup inside container
4. Extract backup from Docker volume
5. Save as `backups/backup_YYYY-MM-DD_HH-MM-SS_local.tar.gz`

**Note**: The script automatically detects and uses `podman` if `docker` is not available. This is useful on RHEL/Fedora/CentOS systems.

### Restore to Local Container

Restore a backup to your local Docker container:

```bash
# Option 1: Use default settings
./scripts/restore-to-local.sh ./backups/backup_2026-01-30_local.tar.gz

# Option 2: Use config file
source scripts/backup-config.sh
./scripts/restore-to-local.sh ./backups/backup_2026-01-30_local.tar.gz

# Option 3: Set variables inline
LOCAL_CONTAINER=point ./scripts/restore-to-local.sh ./backups/backup.tar.gz
```

This will:
1. Upload backup to container
2. Stop the application
3. Restore database and media files
4. Restart the container

**⚠️ WARNING**: This will overwrite all data in the local container!

### Pull Backup from Production

Pull the latest backup from production to your lab machine:

```bash
# Option 1: Use config file
source scripts/backup-config.sh
./scripts/pull-from-production.sh

# Option 2: Set variables inline
PROD_HOST=user@prod.example.com ./scripts/pull-from-production.sh
```

This will:
1. Find the latest backup on production
2. Extract it from Docker volume
3. Download to your lab machine
4. Save as `backups/backup_*_pulled_*.tar.gz`

### Push Backup to Production

Upload a backup from lab to production and restore it:

```bash
# Option 1: Use config file
source scripts/backup-config.sh
./scripts/push-to-production.sh ./backups/backup_2026-01-30.tar.gz

# Option 2: Set variables inline
PROD_HOST=user@prod.example.com ./scripts/push-to-production.sh ./backups/backup_2026-01-30.tar.gz
```

This will:
1. Upload backup to production
2. Stop the application
3. Restore database and media files
4. Restart the application

**⚠️ WARNING**: This will overwrite all data on production!

### Create Local Backup

Create a backup of local data:

```bash
./scripts/backup.sh
```

Creates: `data/backups/backup_YYYY-MM-DD_HH-MM-SS.tar.gz`

### Restore Local Backup

Restore from a local backup file:

```bash
./scripts/restore.sh data/backups/backup_2026-01-30_12-00-00.tar.gz
```

## Common Workflows

### Scenario 1: Backup Production Data

```bash
# Pull production backup to lab for safekeeping
source scripts/backup-config.sh
./scripts/pull-from-production.sh
```

### Scenario 2: Push Local Container to Production

```bash
# Create backup from local container
./scripts/backup-from-local.sh

# Push to production
source scripts/backup-config.sh
./scripts/push-to-production.sh backups/backup_*_local.tar.gz
```

### Scenario 3: Sync Local Container from Production

```bash
# Pull from production
source scripts/backup-config.sh
./scripts/pull-from-production.sh

# Restore to local container
./scripts/restore-to-local.sh backups/backup_*_pulled_*.tar.gz
```

### Scenario 4: Test on Lab Before Production

```bash
# Pull production data to local container
source scripts/backup-config.sh
./scripts/pull-from-production.sh
./scripts/restore-to-local.sh backups/backup_*_pulled_*.tar.gz

# Test changes on lab container...

# Create backup from local container with changes
./scripts/backup-from-local.sh

# Push to production
./scripts/push-to-production.sh backups/backup_*_local.tar.gz
```

### Scenario 5: Quick Local Container Backup

```bash
# Backup local container before risky changes
./scripts/backup-from-local.sh

# Make changes...

# Restore if needed
./scripts/restore-to-local.sh backups/backup_*_local.tar.gz
```

## Automated Backups

### Pull from Production Daily

Add to crontab on lab machine:

```bash
# Edit crontab
crontab -e

# Add daily backup at 2 AM
0 2 * * * cd /opt/point && source scripts/backup-config.sh && ./scripts/pull-from-production.sh >> /var/log/point-backup.log 2>&1
```

## Troubleshooting

### SSH Connection Issues

```bash
# Test SSH connection
ssh user@production-server.com echo "Connection successful"

# Check container is running
ssh user@production-server.com docker ps | grep point-prod
```

### Backup Not Found

If pull script can't find backups, it will attempt to create one automatically using the app's backup service.

### Permission Denied

Make sure scripts are executable:

```bash
chmod +x scripts/*.sh
```

### Container Name Mismatch

Check actual container name on production:

```bash
ssh user@production-server.com docker ps
```

Update `PROD_CONTAINER` in `backup-config.sh` accordingly.

## Backup File Format

Backup files are .tar.gz archives containing:

```
backup_YYYY-MM-DD_HH-MM-SS.tar.gz
├── point.db         # SQLite database
└── media/           # Media files


## Security Notes

- Backups contain all user data and should be kept secure
- Use SSH key authentication instead of passwords
- Store backup-config.sh outside version control (it's in .gitignore)
- Consider encrypting backups if storing off-site
- Regularly test restore procedures

## See Also

- [Backup Service Documentation](../specification.md#backup-restore-system) - Lines 615-653
- [Docker Volume Documentation](../specification.md#docker-configuration) - Lines 551-682
