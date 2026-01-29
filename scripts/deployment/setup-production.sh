#!/bin/bash
# Production Server Setup Script
# This script prepares a fresh server for Photo Blog deployment

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    log_error "Please run as root (use sudo)"
    exit 1
fi

log_info "========================================="
log_info "Photo Blog - Production Server Setup"
log_info "========================================="

# Update system
log_info "Updating system packages..."
apt-get update
apt-get upgrade -y
log_success "System updated"

# Install Docker
log_info "Installing Docker..."
if ! command -v docker &> /dev/null; then
    # Install dependencies
    apt-get install -y \
        ca-certificates \
        curl \
        gnupg \
        lsb-release

    # Add Docker's official GPG key
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg

    # Set up repository
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

    # Install Docker Engine
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

    # Start and enable Docker
    systemctl start docker
    systemctl enable docker

    log_success "Docker installed"
else
    log_warning "Docker already installed"
fi

# Install Docker Compose (standalone)
log_info "Installing Docker Compose..."
if ! command -v docker-compose &> /dev/null; then
    DOCKER_COMPOSE_VERSION="v2.24.5"
    curl -L "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-$(uname -s)-$(uname -m)" \
        -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    log_success "Docker Compose installed"
else
    log_warning "Docker Compose already installed"
fi

# Create deployment user
log_info "Creating deployment user..."
if ! id "deploy" &>/dev/null; then
    useradd -m -s /bin/bash deploy
    usermod -aG docker deploy
    log_success "User 'deploy' created"
else
    log_warning "User 'deploy' already exists"
fi

# Create project directory
log_info "Creating project directory..."
PROJECT_DIR="/opt/photo-blog"
DATA_DIR="/var/lib/photo-blog/data"

mkdir -p "$PROJECT_DIR"
mkdir -p "$DATA_DIR"/{media,cache,logs,backups}

chown -R deploy:deploy "$PROJECT_DIR"
chown -R deploy:deploy "$DATA_DIR"

log_success "Directories created"

# Install certbot for SSL
log_info "Installing Certbot for SSL certificates..."
apt-get install -y certbot
log_success "Certbot installed"

# Install fail2ban for security
log_info "Installing fail2ban..."
apt-get install -y fail2ban
systemctl start fail2ban
systemctl enable fail2ban
log_success "fail2ban installed"

# Configure firewall
log_info "Configuring firewall..."
if command -v ufw &> /dev/null; then
    ufw --force enable
    ufw default deny incoming
    ufw default allow outgoing
    ufw allow ssh
    ufw allow http
    ufw allow https
    log_success "Firewall configured"
else
    log_warning "UFW not found, skipping firewall configuration"
fi

# Set up SSH key for deployment
log_info "Setting up SSH for deployment user..."
DEPLOY_HOME="/home/deploy"
mkdir -p "$DEPLOY_HOME/.ssh"
chmod 700 "$DEPLOY_HOME/.ssh"

if [ ! -f "$DEPLOY_HOME/.ssh/authorized_keys" ]; then
    touch "$DEPLOY_HOME/.ssh/authorized_keys"
    chmod 600 "$DEPLOY_HOME/.ssh/authorized_keys"
fi

chown -R deploy:deploy "$DEPLOY_HOME/.ssh"

log_info "Add your deployment SSH public key to: $DEPLOY_HOME/.ssh/authorized_keys"

# Create systemd service (optional)
log_info "Creating systemd service..."
cat > /etc/systemd/system/photo-blog.service <<'EOF'
[Unit]
Description=Photo Blog
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/photo-blog
ExecStart=/usr/local/bin/docker-compose -f docker-compose.prod.yml up -d
ExecStop=/usr/local/bin/docker-compose -f docker-compose.prod.yml down
User=deploy
Group=deploy

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
log_success "Systemd service created"

# Set up log rotation
log_info "Configuring log rotation..."
cat > /etc/logrotate.d/photo-blog <<'EOF'
/var/lib/photo-blog/data/logs/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 deploy deploy
    sharedscripts
    postrotate
        docker-compose -f /opt/photo-blog/docker-compose.prod.yml restart blog >/dev/null 2>&1 || true
    endscript
}
EOF
log_success "Log rotation configured"

# Create backup cron job
log_info "Setting up automated backups..."
cat > /etc/cron.d/photo-blog-backup <<'EOF'
# Photo Blog automated backup
0 2 * * * deploy cd /opt/photo-blog && /opt/photo-blog/scripts/backup.sh >/var/log/photo-blog-backup.log 2>&1
EOF
log_success "Backup cron job created"

# Summary
log_success "========================================="
log_success "Server setup completed!"
log_success "========================================="
echo ""
log_info "Next steps:"
echo "1. Add deployment SSH key to /home/deploy/.ssh/authorized_keys"
echo "2. Clone repository to /opt/photo-blog"
echo "3. Copy .env.production.example to .env and configure"
echo "4. Obtain SSL certificate: certbot certonly --standalone -d yourdomain.com"
echo "5. Deploy: cd /opt/photo-blog && ./scripts/deployment/deploy.sh"
echo ""
log_info "Deployment user: deploy"
log_info "Project directory: $PROJECT_DIR"
log_info "Data directory: $DATA_DIR"
