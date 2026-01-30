# Production Server Setup for Backup Scripts

This guide explains how to set up your production server to allow backup/restore operations without requiring manual password entry.

## Prerequisites

- SSH access to production server
- Photo Blog container running on production
- Ability to run commands as root (for initial setup only)

## Option 1: Add User to Docker Group (Recommended for Simplicity)

This allows your user to run Docker commands without sudo.

### On Production Server

```bash
# SSH to production
ssh user@production-server.com

# Add your user to the docker group
sudo usermod -aG docker $USER

# Log out and back in for changes to take effect
exit
ssh user@production-server.com

# Verify docker access (should work without sudo)
docker ps
```

### In backup-config.sh

```bash
# Leave PROD_SUDO empty
export PROD_SUDO=""
```

### Security Note

Users in the docker group have root-equivalent privileges. Only use this for trusted users.

---

## Option 2: Configure Passwordless Sudo (Recommended for Security)

This allows specific docker commands to run with sudo without password prompt.

### On Production Server

```bash
# SSH to production
ssh user@production-server.com

# Create sudoers file for docker commands
sudo visudo -f /etc/sudoers.d/docker-backup

# Add these lines (replace 'username' with your actual username):
username ALL=(ALL) NOPASSWD: /usr/bin/docker exec photo-blog *
username ALL=(ALL) NOPASSWD: /usr/bin/docker cp photo-blog\:* *
username ALL=(ALL) NOPASSWD: /usr/bin/docker cp * photo-blog\:*
username ALL=(ALL) NOPASSWD: /usr/bin/docker restart photo-blog

# Save and exit (Ctrl+X, then Y, then Enter)

# Set proper permissions
sudo chmod 0440 /etc/sudoers.d/docker-backup

# Test sudo access (should not ask for password)
sudo docker ps
```

### In backup-config.sh

```bash
# Set PROD_SUDO to use sudo
export PROD_SUDO="sudo"
```

### Security Note

This approach is more secure as it only grants passwordless sudo for specific docker commands related to the backup container.

---

## Option 3: Run Docker as Root (Not Recommended)

If you must use root access, you can SSH as root directly.

### In backup-config.sh

```bash
# Use root user in SSH connection
export PROD_HOST="root@production-server.com"
export PROD_SUDO=""
```

### Security Note

Running as root increases security risk. Use SSH key authentication and disable root password login in `/etc/ssh/sshd_config`.

---

## Verify Setup

After choosing an option, test your configuration:

### Test 1: SSH Connection

```bash
ssh user@production-server.com echo "Connection successful"
```

### Test 2: Docker Access

```bash
# Without sudo (if using Option 1)
ssh user@production-server.com docker ps

# With sudo (if using Option 2)
ssh user@production-server.com sudo docker ps
```

### Test 3: Container Access

```bash
# Replace with your actual setup
source scripts/backup-config.sh

# Test docker exec
ssh "$PROD_HOST" ${PROD_SUDO:+$PROD_SUDO }docker exec $PROD_CONTAINER echo "Container access works"
```

### Test 4: Full Backup Pull

```bash
source scripts/backup-config.sh
./scripts/pull-from-production.sh
```

---

## Troubleshooting

### "Permission denied" when running docker

**Problem**: User doesn't have docker access

**Solution**:
- Option 1: Add user to docker group (requires logout/login)
- Option 2: Configure sudo as shown above
- Verify with: `groups` (should show "docker" group)

### "sudo: a password is required"

**Problem**: Sudo requires password

**Solution**:
- Set up NOPASSWD sudo as shown in Option 2
- Verify sudoers file: `sudo visudo -c`
- Test: `sudo -n docker ps` (should work without prompt)

### "Container not found"

**Problem**: Container name mismatch

**Solution**:
```bash
# Check actual container name
ssh user@production-server.com docker ps

# Update backup-config.sh with correct name
export PROD_CONTAINER="actual-container-name"
```

### SSH asks for password every time

**Problem**: SSH key not configured

**Solution**:
```bash
# Generate SSH key if needed
ssh-keygen -t ed25519 -C "backup-automation"

# Copy to production
ssh-copy-id user@production-server.com

# Test passwordless login
ssh user@production-server.com echo "Success"
```

---

## Security Best Practices

1. **Use SSH Keys**: Never use password authentication for automated scripts
2. **Restrict Permissions**: Use Option 2 (NOPASSWD sudo) for specific commands only
3. **Backup Encryption**: Consider encrypting backups if storing off-site
4. **Regular Audits**: Review `/var/log/auth.log` for suspicious access
5. **Firewall**: Restrict SSH access to known IP addresses if possible
6. **Disable Root SSH**: Set `PermitRootLogin no` in `/etc/ssh/sshd_config`

---

## Quick Setup Checklist

- [ ] SSH key authentication configured
- [ ] User added to docker group OR sudo configured for docker commands
- [ ] `backup-config.sh` created and configured
- [ ] Test connection: `ssh $PROD_HOST echo "OK"`
- [ ] Test docker access: `ssh $PROD_HOST $PROD_SUDO docker ps`
- [ ] Test backup pull: `./scripts/pull-from-production.sh`
- [ ] Review security settings

---

## Next Steps

Once production access is configured:

1. Test pulling a backup: `./scripts/pull-from-production.sh`
2. Set up automated backups (see main README.md)
3. Document your production server details
4. Test disaster recovery procedure

For more information, see [scripts/README.md](./README.md)
