# Production Deployment Guide

This guide covers setting up Point on a production server using Docker Compose, Systemd, and Nginx.

## Prerequisites

- A Linux server (Ubuntu/Debian recommended)
- A domain name pointing to your server's IP
- Docker and Docker Compose installed (or use the setup script)

## Automated Server Setup

You can use the included setup script to prepare your server:

```bash
sudo ./scripts/setup-production.sh
```

This script will:
1. Install Docker and Docker Compose
2. Create a `deploy` user
3. Set up directory structure in `/opt/point` and `/var/lib/point/data`
4. Install Certbot (for SSL) and fail2ban (for security)
5. Configure a basic UFW firewall
6. Create a Systemd service for Point
7. Configure log rotation and a backup cron job

## Manual Setup

### 1. Directory Structure

We recommend the following structure:
- `/opt/point`: Application files (compose file, .env)
- `/var/lib/point/data`: Persistent data (database, photos, backups)

### 2. Docker Compose

Use the `quickstart/docker-compose.yml` as a base. For production, you may want to use a specific version tag instead of `latest`.

### 3. Nginx Reverse Proxy

We recommend running Point behind Nginx for SSL termination and better performance.

Example Nginx configuration (`/etc/nginx/sites-available/point`):

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    client_max_body_size 100M;

    location / {
        proxy_pass http://localhost:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 4. SSL Certificate

Use Certbot to obtain a free SSL certificate from Let's Encrypt:

```bash
sudo certbot certonly --nginx -d yourdomain.com
```

### 5. Systemd Service

Create `/etc/systemd/system/point.service`:

```ini
[Unit]
Description=Point Blog
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/point
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
User=deploy
Group=deploy

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo systemctl enable point
sudo systemctl start point
```

## Backups

Point stores all data in the directory mapped to `/data` in the container. To backup Point, simply backup this directory.

The `setup-production.sh` script sets up a daily cron job that runs a backup script. Ensure you copy your backups off-site periodically.

## Monitoring

Check logs using:
```bash
docker compose logs -f
# or
journalctl -u point -f
```
