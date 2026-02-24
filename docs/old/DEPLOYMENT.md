# Photo Blog - Deployment Guide

This guide provides comprehensive instructions for deploying Photo Blog to production.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Server Setup](#server-setup)
3. [GitHub Actions CI/CD](#github-actions-cicd)
4. [Manual Deployment](#manual-deployment)
5. [SSL/TLS Configuration](#ssltls-configuration)
6. [Environment Configuration](#environment-configuration)
7. [Backup & Recovery](#backup--recovery)
8. [Monitoring & Maintenance](#monitoring--maintenance)
9. [Troubleshooting](#troubleshooting)

## Prerequisites

### Server Requirements

- **OS**: Ubuntu 24.04 LTS (recommended) or compatible Linux distribution
- **RAM**: Minimum 1GB, recommended 2GB
- **Disk**: Minimum 10GB free space (more if storing many images)
- **CPU**: 1 core minimum, 2 cores recommended
- **Network**: Static IP address or domain name

### Required Software

- Docker 24.0+
- Docker Compose 2.20+
- Git
- curl
- certbot (for SSL certificates)

### Domain & DNS

- A registered domain name
- DNS A record pointing to your server's IP address

## Server Setup

### Automated Setup (Recommended)

Run the automated setup script as root:

```bash
curl -fsSL https://raw.githubusercontent.com/username/point/main/scripts/deployment/setup-production.sh | sudo bash
```

Or manually:

```bash
git clone https://github.com/dariy/point.git /tmp/point
cd /tmp/point
sudo chmod +x scripts/deployment/setup-production.sh
sudo ./scripts/deployment/setup-production.sh
```

This script will:
1. Update system packages
2. Install Docker and Docker Compose
3. Create `deploy` user with sudo privileges
4. Set up project directories (`/opt/point`, `/var/lib/point/data`)
5. Configure firewall (UFW) to allow HTTP, HTTPS, and SSH
6. Install fail2ban for SSH protection
7. Install certbot for SSL certificates
8. Set up log rotation
9. Create systemd service for auto-start
10. Configure automated backups (daily at 2 AM)

### Manual Setup

If you prefer to set up manually:

1. **Update system**:
   ```bash
   sudo apt-get update && sudo apt-get upgrade -y
   ```

2. **Install Docker**:
   ```bash
   curl -fsSL https://get.docker.com -o get-docker.sh
   sudo sh get-docker.sh
   sudo usermod -aG docker $USER
   ```

3. **Install Docker Compose**:
   ```bash
   sudo curl -L "https://github.com/docker/compose/releases/download/v2.24.5/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
   sudo chmod +x /usr/local/bin/docker-compose
   ```

4. **Create deployment user**:
   ```bash
   sudo useradd -m -s /bin/bash deploy
   sudo usermod -aG docker deploy
   sudo passwd deploy  # Set password
   ```

5. **Create directories**:
   ```bash
   sudo mkdir -p /opt/point
   sudo mkdir -p /var/lib/point/data/{media,cache,logs,backups}
   sudo chown -R deploy:deploy /opt/point
   sudo chown -R deploy:deploy /var/lib/point
   ```

6. **Configure firewall**:
   ```bash
   sudo ufw enable
   sudo ufw allow ssh
   sudo ufw allow http
   sudo ufw allow https
   ```

## GitHub Actions CI/CD

### Overview

The project includes two GitHub Actions workflows:

1. **test.yml**: Runs on pull requests - linting, type checking, and tests
2. **deploy.yml**: Runs on push to main - builds, tests, and deploys

### Setting Up GitHub Actions

#### 1. Generate SSH Key for Deployment

On your local machine:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/deploy_key -N ""
```

#### 2. Add Public Key to Server

```bash
ssh-copy-id -i ~/.ssh/deploy_key.pub deploy@yourdomain.com
```

Or manually:

```bash
# On your server as deploy user
mkdir -p ~/.ssh
chmod 700 ~/.ssh
nano ~/.ssh/authorized_keys  # Paste public key here
chmod 600 ~/.ssh/authorized_keys
```

#### 3. Configure GitHub Secrets

Go to your repository on GitHub → Settings → Secrets and variables → Actions → New repository secret

Add these secrets:

| Secret Name | Value | Description |
|-------------|-------|-------------|
| `DEPLOY_HOST` | `yourdomain.com` | Your server's domain or IP |
| `DEPLOY_USER` | `deploy` | SSH username |
| `DEPLOY_SSH_KEY` | `[contents of ~/.ssh/deploy_key]` | Private SSH key |
| `DEPLOY_SSH_PORT` | `22` | SSH port (optional, default: 22) |
| `DEPLOY_PATH` | `/opt/point` | Application directory |
| `CODECOV_TOKEN` | `[from codecov.io]` | For coverage reports (optional) |

To get the private key:
```bash
cat ~/.ssh/deploy_key
```

Copy the entire output (including `-----BEGIN OPENSSH PRIVATE KEY-----` and `-----END OPENSSH PRIVATE KEY-----`).

#### 4. Enable GitHub Container Registry

The workflow publishes Docker images to GitHub Container Registry (ghcr.io).

1. Go to your repository → Settings → Actions → General
2. Scroll to "Workflow permissions"
3. Select "Read and write permissions"
4. Save

#### 5. Prepare Production Server

On your server as `deploy` user:

```bash
cd /opt/point
git clone https://github.com/dariy/point.git .
cp .env.production.example .env
nano .env  # Configure environment variables
```

Generate secrets:
```bash
python3 -c "import secrets; print('SECRET_KEY=' + secrets.token_urlsafe(64))"
python3 -c "import secrets; print('SESSION_SECRET=' + secrets.token_urlsafe(64))"
```

#### 6. Test Deployment

Push to main branch to trigger deployment:

```bash
git add .
git commit -m "feat: initial deployment"
git push origin main
```

Watch the workflow in GitHub Actions tab.

### Workflow Details

**On Pull Request**:
- ✅ Linting (ruff)
- ✅ Type checking (mypy)
- ✅ Unit tests (pytest)
- ✅ Coverage report

**On Push to Main**:
- ✅ All PR checks
- ✅ Build Docker image
- ✅ Push to ghcr.io
- ✅ Deploy to production server
- ✅ Health check
- ✅ Auto-rollback on failure

## Manual Deployment

### Initial Deployment

1. **Clone repository**:
   ```bash
   ssh deploy@yourdomain.com
   cd /opt/point
   git clone https://github.com/dariy/point.git .
   ```

2. **Configure environment**:
   ```bash
   cp .env.production.example .env
   nano .env
   ```

3. **Deploy**:
   ```bash
   ./scripts/deployment/deploy.sh
   ```

### Subsequent Deployments

```bash
cd /opt/point
git pull origin main
./scripts/deployment/deploy.sh
```

### Deployment Script Features

The `deploy.sh` script:
- ✅ Validates environment configuration
- ✅ Creates pre-deployment backup
- ✅ Pulls latest Docker image
- ✅ Deploys new version
- ✅ Runs health checks
- ✅ Auto-rollback on failure
- ✅ Cleans up old Docker images

## SSL/TLS Configuration

### Using Let's Encrypt (Recommended)

1. **Install certbot** (if not already installed):
   ```bash
   sudo apt-get install certbot
   ```

2. **Obtain certificate**:
   ```bash
   sudo certbot certonly --standalone -d yourdomain.com
   ```

   Follow the prompts. Certbot will save certificates to `/etc/letsencrypt/live/yourdomain.com/`.

3. **Copy certificates to project**:
   ```bash
   sudo cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem /opt/point/nginx/ssl/
   sudo cp /etc/letsencrypt/live/yourdomain.com/privkey.pem /opt/point/nginx/ssl/
   sudo chown deploy:deploy /opt/point/nginx/ssl/*.pem
   sudo chmod 644 /opt/point/nginx/ssl/fullchain.pem
   sudo chmod 600 /opt/point/nginx/ssl/privkey.pem
   ```

4. **Set up auto-renewal**:
   ```bash
   sudo crontab -e
   ```

   Add:
   ```
   0 3 * * * certbot renew --quiet && cp /etc/letsencrypt/live/yourdomain.com/*.pem /opt/point/nginx/ssl/ && docker-compose -f /opt/point/docker-compose.prod.yml restart nginx
   ```

### Using Self-Signed Certificate (Development/Testing)

```bash
cd /opt/point/nginx/ssl
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout privkey.pem \
  -out fullchain.pem \
  -subj "/C=US/ST=State/L=City/O=Organization/CN=yourdomain.com"
```

⚠️ **Note**: Self-signed certificates will show security warnings in browsers.

## Environment Configuration

### Required Variables

These must be configured in `.env`:

```bash
# Security (REQUIRED)
SECRET_KEY=<64+ character random string>
SESSION_SECRET=<64+ character random string>

# Blog Settings
BLOG_TITLE=My Photo Blog
BLOG_URL=https://yourdomain.com
BLOG_AUTHOR=Your Name

# GitHub Container Registry (for CI/CD)
GITHUB_REPOSITORY=username/point
```

### Optional Variables

See `.env.production.example` for complete list:

- `MAX_UPLOAD_SIZE`: Max file size (default: 50MB)
- `STORAGE_QUOTA`: Total storage limit (default: 10GB)
- `CACHE_TTL`: Cache duration (default: 3600 seconds)
- `BACKUP_RETENTION_DAYS`: Keep backups for N days (default: 30)
- `LOG_LEVEL`: Logging verbosity (default: INFO)

### Generating Secrets

```bash
# Generate SECRET_KEY
python3 -c "import secrets; print(secrets.token_urlsafe(64))"

# Generate SESSION_SECRET
python3 -c "import secrets; print(secrets.token_urlsafe(64))"
```

## Backup & Recovery

### Automated Backups

Backups run daily at 2 AM by default. Configure in `.env`:

```bash
BACKUP_ENABLED=true
BACKUP_SCHEDULE=0 2 * * *  # Cron format
BACKUP_RETENTION_DAYS=30
```

### Manual Backup

```bash
cd /opt/point
./scripts/backup.sh
```

Backups are saved to `/var/lib/point/data/backups/`.

### Restore from Backup

```bash
./scripts/restore.sh /var/lib/point/data/backups/2024-01-01_02-00-00.tar.gz
```

### Off-Site Backups (Recommended)

Configure S3/Backblaze B2 in `.env`:

```bash
BACKUP_S3_ENABLED=true
BACKUP_S3_BUCKET=my-blog-backups
BACKUP_S3_REGION=us-east-1
BACKUP_S3_ACCESS_KEY=your_access_key
BACKUP_S3_SECRET_KEY=your_secret_key
```

## Monitoring & Maintenance

### Health Checks

**Automated**:
- GitHub Actions runs health check after deployment
- Docker healthcheck runs every 30 seconds

**Manual**:
```bash
./scripts/deployment/health-check.sh
```

Or:
```bash
curl https://yourdomain.com/health
```

### Viewing Logs

```bash
# Application logs
docker-compose -f docker-compose.prod.yml logs -f blog

# Nginx logs
docker-compose -f docker-compose.prod.yml logs -f nginx

# All logs
docker-compose -f docker-compose.prod.yml logs -f

# View log files directly
tail -f /var/lib/point/data/logs/app.log
```

### System Statistics

Access light dashboard: `https://yourdomain.com/light/`

View:
- Storage usage
- Database size
- Cache statistics
- Active sessions
- Recent activity

### Maintenance Tasks

**Daily** (automated):
- Database backup
- Session cleanup
- View count flushing

**Weekly**:
- Review logs: `tail -100 /var/lib/point/data/logs/app.log`
- Check disk space: `df -h /var/lib/point`

**Monthly**:
- Test backup restore
- Update dependencies: `docker-compose pull && docker-compose up -d`
- Review security settings

**Quarterly**:
- Update OS packages: `sudo apt-get update && sudo apt-get upgrade`
- Renew SSL certificate (if not auto-renewing)
- Review and rotate secrets

## Troubleshooting

### Service Won't Start

```bash
# Check logs
docker-compose -f docker-compose.prod.yml logs blog

# Check container status
docker-compose -f docker-compose.prod.yml ps

# Restart service
docker-compose -f docker-compose.prod.yml restart blog
```

### Database Corruption

```bash
# Restore from backup
./scripts/restore.sh /var/lib/point/data/backups/latest.tar.gz

# If backup is also corrupted, try SQLite recovery
cd /var/lib/point/data
sqlite3 blog.db ".recover" > recovered.sql
mv blog.db blog.db.corrupted
sqlite3 blog.db < recovered.sql
```

### SSL Certificate Issues

```bash
# Check certificate expiry
openssl x509 -in /opt/point/nginx/ssl/fullchain.pem -noout -dates

# Renew certificate
sudo certbot renew

# Copy renewed certificates
sudo cp /etc/letsencrypt/live/yourdomain.com/*.pem /opt/point/nginx/ssl/

# Restart nginx
docker-compose -f docker-compose.prod.yml restart nginx
```

### High Memory Usage

```bash
# Check container stats
docker stats

# Restart services
docker-compose -f docker-compose.prod.yml restart

# Clear cache
curl -X POST https://yourdomain.com/api/system/cache/clear \
  -H "Cookie: session=YOUR_SESSION_TOKEN"
```

### Failed Deployment

The deployment script automatically rolls back on failure. To manually rollback:

```bash
./scripts/deployment/deploy.sh rollback
```

### GitHub Actions Deployment Fails

1. **Check GitHub Actions logs**: Repository → Actions → Select failed workflow
2. **Verify secrets**: Settings → Secrets and variables → Actions
3. **Test SSH connection**:
   ```bash
   ssh deploy@yourdomain.com "echo OK"
   ```
4. **Check server logs**:
   ```bash
   ssh deploy@yourdomain.com "docker-compose -f /opt/point/docker-compose.prod.yml logs"
   ```

### 502 Bad Gateway

Usually means the blog service is not running:

```bash
docker-compose -f docker-compose.prod.yml ps
docker-compose -f docker-compose.prod.yml restart blog
```

### Disk Space Full

```bash
# Check usage
df -h /var/lib/point

# Clean old Docker images
docker image prune -a

# Clean old backups
find /var/lib/point/data/backups -name "*.tar.gz" -mtime +30 -delete

# Clean cache
rm -rf /var/lib/point/data/cache/*
```

## Performance Optimization

### Enable HTTP/2

Already enabled in nginx configuration. Ensure you're using HTTPS.

### CDN Integration

Consider using Cloudflare for:
- DDoS protection
- Global CDN
- Automatic image optimization
- Free SSL certificates

### Database Optimization

```bash
# Vacuum database monthly
docker-compose -f docker-compose.prod.yml exec blog \
  python -c "import sqlite3; conn = sqlite3.connect('/data/blog.db'); conn.execute('VACUUM'); conn.close()"
```

### Cache Tuning

Adjust in `.env`:
```bash
CACHE_ENABLED=true
CACHE_TTL=7200  # Increase for better performance
```

## Security Hardening

### Recommended Security Measures

1. **Change default SSH port**:
   ```bash
   sudo nano /etc/ssh/sshd_config
   # Port 2222
   sudo systemctl restart sshd
   ```

2. **Enable fail2ban**:
   ```bash
   sudo systemctl enable fail2ban
   sudo systemctl start fail2ban
   ```

3. **Regular updates**:
   ```bash
   sudo apt-get update && sudo apt-get upgrade -y
   ```

4. **Use strong passwords**:
   - Generate: `openssl rand -base64 32`
   - Change light password after first login

5. **Enable two-factor authentication** (future enhancement)

6. **Regular backup testing**

## Additional Resources

- **Specification**: [specification.md](specification.md)
- **Development Phases**: [phases.md](phases.md)
- **Main README**: [README.md](README.md)
- **Nginx Configuration**: [nginx/README.md](nginx/README.md)

## Support

For issues and questions:
- Check troubleshooting section above
- Review application logs
- Search existing GitHub issues
- Open a new issue with details

---

**Happy Deploying! 🚀**
