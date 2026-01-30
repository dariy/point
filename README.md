# Photo Blog Engine

A lightweight, professional-grade personal photo blog engine built with FastAPI, SQLite, and Docker. Designed for photographers and visual storytellers who want a fast, self-hosted, and beautiful way to share their work.

## ✨ Key Features

- **🚀 Performance-First**: Fast server-side rendering with Jinja2 and file-based caching.
- **🖼️ Media-Centric**: Automatic thumbnail generation, image resizing, and video support.
- **📱 Modern UX**:
    - **Immersive Mode**: Full-screen, distraction-free viewing for photo-heavy posts.
    - **AJAX Navigation**: Seamless transitions between pages without full reloads.
    - **Gesture Support**: Swipe navigation for touch devices and carousels.
- **🌓 Dual Themes**: Beautiful dark and light modes with system preference detection.
- **🛠️ Professional Tools**:
    - Full post management with Markdown support.
    - Tagging system with automatic post counts.
    - Integrated backup/restore system.
    - System health and log monitoring.
- **🔒 Secure & Private**: Self-hosted, single-user authentication, and security-hardened headers.
- **📦 Single Container**: Easy deployment with Docker and SQLite.

## 🚀 Quick Start

### Prerequisites

- Docker and Docker Compose. Podman and Podman Compose as an alternative.
- (Optional) Python 3.12+ for local development

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/username/photo-blog.git
   cd photo-blog
   ```

2. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your desired settings
   ```

3. **Start the application**:
   ```bash
   docker compose up -d
   # or
   podman compose up -d
   ```

4. **Initialize the database**:
   ```bash
   docker compose exec blog python scripts/init_db.py
   # or
   podman compose exec blog python scripts/init_db.py
   ```

The blog will be available at `http://localhost:8000`. The admin interface ("Light") is at `http://localhost:8000/light/login`.

## ⚙️ Configuration

The application is configured via environment variables in the `.env` file. Key settings include:

- `APP_NAME`: Title of your blog.
- `SECRET_KEY`: Random string for session security.
- `STORAGE_PATH`: Directory for database and media storage (default: `/data`).
- `MAX_IMAGE_WIDTH`: Maximum width for uploaded images (auto-resized).
- `JPEG_QUALITY`: Quality setting for generated images (1-100).

## 🛠️ Development

### Local Setup (without Docker)

1. Create a virtual environment:
   ```bash
   python -m venv venv
   source venv/bin/activate  # or venv\Scripts\activate on Windows
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   pip install pytest ruff mypy
   ```

3. Run the development server:
   ```bash
   uvicorn app.main:app --reload
   ```

### Running Tests

```bash
pytest
```

### Linting & Type Checking

```bash
ruff check .
mypy app/
```

## 📂 Project Structure

- `app/`: FastAPI application code.
- `data/`: Persistent storage (mounted as volume in Docker).
- `scripts/`: Database initialization, backup, and restore scripts.
- `.github/workflows/`: CI/CD pipelines for automated testing and deployment.
- `nginx/`: Nginx reverse proxy configuration for production.
- `tests/`: Comprehensive test suite.
- `specification.md`: Detailed technical design.
- `phases.md`: Development roadmap and progress.

## 🚀 Production Deployment

### Prerequisites

- Ubuntu 24.04 LTS server (or similar)
- Domain name pointing to your server
- SSH access to the server
- Docker and Docker Compose installed

### Quick Production Setup

1. **Run the setup script on your server** (as root):
   ```bash
   sudo ./scripts/deployment/setup-production.sh
   ```

   This script will:
   - Install Docker and Docker Compose
   - Create a `deploy` user
   - Set up directories and permissions
   - Configure firewall (UFW)
   - Install Certbot for SSL certificates
   - Set up automated backups and log rotation

2. **Clone the repository**:
   ```bash
   su - deploy
   cd /opt/photo-blog
   git clone https://github.com/username/photo-blog.git .
   ```

3. **Configure environment**:
   ```bash
   cp .env.production.example .env
   nano .env  # Edit with your production settings
   ```

   **Important**: Generate secure secrets:
   ```bash
   python -c "import secrets; print(secrets.token_urlsafe(64))"
   ```

4. **Obtain SSL certificate**:
   ```bash
   sudo certbot certonly --standalone -d yourdomain.com
   sudo cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem nginx/ssl/
   sudo cp /etc/letsencrypt/live/yourdomain.com/privkey.pem nginx/ssl/
   sudo chown deploy:deploy nginx/ssl/*.pem
   ```

5. **Deploy the application**:
   ```bash
   ./scripts/deployment/deploy.sh
   ```

6. **Verify deployment**:
   ```bash
   ./scripts/deployment/health-check.sh
   ```

Your blog should now be available at `https://yourdomain.com`!

### GitHub Actions CI/CD

This project includes automated CI/CD pipelines that:

- **On Pull Requests**: Run tests, linting, and type checking
- **On Push to Main**: Build Docker image, run tests, and deploy to production

#### Required GitHub Secrets

Configure these secrets in your GitHub repository (Settings → Secrets and variables → Actions):

| Secret | Description | Example |
|--------|-------------|---------|
| `DEPLOY_HOST` | Production server hostname | `yourdomain.com` |
| `DEPLOY_USER` | SSH user for deployment | `deploy` |
| `DEPLOY_SSH_KEY` | Private SSH key for deployment | Contents of `~/.ssh/id_rsa` |
| `DEPLOY_SSH_PORT` | SSH port (optional) | `22` |
| `DEPLOY_PATH` | Application directory on server | `/opt/photo-blog` |
| `CODECOV_TOKEN` | Codecov token (optional) | From codecov.io |

#### Setting Up SSH Key for Deployment

1. Generate SSH key on your local machine:
   ```bash
   ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/deploy_key
   ```

2. Add public key to server:
   ```bash
   ssh-copy-id -i ~/.ssh/deploy_key.pub deploy@yourdomain.com
   ```

3. Add private key as GitHub secret:
   ```bash
   cat ~/.ssh/deploy_key  # Copy this to DEPLOY_SSH_KEY secret
   ```

### Manual Deployment

For manual deployments without GitHub Actions:

```bash
# On your production server
cd /opt/photo-blog
git pull origin main
./scripts/deployment/deploy.sh
```

The deployment script will:
- Create a pre-deployment backup
- Pull the latest Docker image
- Deploy the new version
- Run health checks
- Automatically rollback if deployment fails

### Deployment Checklist

Before deploying to production:

- [ ] Configure all environment variables in `.env`
- [ ] Generate secure `SECRET_KEY` and `SESSION_SECRET`
- [ ] Set up SSL certificates
- [ ] Configure DNS to point to your server
- [ ] Set up firewall rules (ports 80, 443, SSH)
- [ ] Configure automated backups
- [ ] Set up monitoring/alerts
- [ ] Test backup and restore procedures
- [ ] Review security settings
- [ ] Set up log rotation

### Production Maintenance

**Daily Automated Tasks**:
- Database backups (2 AM by default)
- Session cleanup (hourly)
- View count flushing (every 30 minutes)

**Manual Maintenance**:
```bash
# View logs
docker-compose -f docker-compose.prod.yml logs -f blog

# Create manual backup
./scripts/backup.sh

# Restore from backup
./scripts/restore.sh /data/backups/2024-01-01.tar.gz

# Check system health
./scripts/deployment/health-check.sh

# Update application
cd /opt/photo-blog
git pull origin main
./scripts/deployment/deploy.sh
```

### Monitoring

Access the admin dashboard at `https://yourdomain.com/light/` to view:
- System statistics (storage, database size, cache stats)
- Application logs
- Active sessions
- Recent posts and activity

### Troubleshooting

**Service won't start**:
```bash
docker-compose -f docker-compose.prod.yml logs blog
```

**Database issues**:
```bash
# Check database file
ls -lh /var/lib/photo-blog/data/blog.db

# Restore from backup
./scripts/restore.sh /data/backups/latest.tar.gz
```

**SSL certificate renewal**:
```bash
sudo certbot renew
sudo cp /etc/letsencrypt/live/yourdomain.com/*.pem /opt/photo-blog/nginx/ssl/
docker-compose -f docker-compose.prod.yml restart nginx
```

**Rollback deployment**:
```bash
./scripts/deployment/deploy.sh rollback
```

## 📊 Monitoring & Performance

- **Health Check Endpoint**: `https://yourdomain.com/health`
- **System Stats**: Available in the admin dashboard
- **Logs**: `/var/lib/photo-blog/data/logs/`
- **Backups**: `/var/lib/photo-blog/data/backups/`

## 🔒 Security

- All passwords are hashed with bcrypt
- Session tokens are cryptographically secure
- HTTPS enforced in production
- Security headers configured (CSP, X-Frame-Options, etc.)
- File upload validation (type, size, content)
- Rate limiting on authentication endpoints
- Regular automated backups

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

Built with:
- [FastAPI](https://fastapi.tiangolo.com/) - Modern Python web framework
- [SQLAlchemy](https://www.sqlalchemy.org/) - SQL toolkit and ORM
- [Jinja2](https://jinja.palletsprojects.com/) - Template engine
- [Pillow](https://python-pillow.org/) - Image processing
- [Docker](https://www.docker.com/) - Containerization

---

**Need Help?** Check out the [specification.md](specification.md) for detailed technical documentation.
