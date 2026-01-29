# Nginx Configuration for Photo Blog

This directory contains nginx configuration files for production deployment with HTTPS support.

## Setup SSL Certificates

### Option 1: Let's Encrypt (Recommended)

1. Install certbot:
```bash
sudo apt-get update
sudo apt-get install certbot
```

2. Obtain certificate:
```bash
sudo certbot certonly --standalone -d yourdomain.com
```

3. Copy certificates to nginx/ssl:
```bash
sudo cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem nginx/ssl/
sudo cp /etc/letsencrypt/live/yourdomain.com/privkey.pem nginx/ssl/
sudo chmod 644 nginx/ssl/fullchain.pem
sudo chmod 600 nginx/ssl/privkey.pem
```

4. Set up auto-renewal:
```bash
sudo crontab -e
# Add this line:
0 3 * * * certbot renew --quiet && docker-compose -f /opt/photo-blog/docker-compose.prod.yml restart nginx
```

### Option 2: Self-Signed Certificate (Development/Testing)

```bash
cd nginx/ssl
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout privkey.pem \
  -out fullchain.pem \
  -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"
```

## File Structure

```
nginx/
├── README.md           # This file
├── nginx.conf          # Main nginx configuration
├── conf.d/
│   └── blog.conf       # Blog-specific configuration
└── ssl/
    ├── fullchain.pem   # SSL certificate (not in git)
    └── privkey.pem     # SSL private key (not in git)
```

## Configuration Details

- **HTTP to HTTPS redirect**: All HTTP traffic is redirected to HTTPS
- **Static file serving**: nginx serves static files directly for better performance
- **Caching**: Appropriate cache headers for static assets
- **Security headers**: X-Frame-Options, X-Content-Type-Options, etc.
- **Gzip compression**: Enabled for text-based content
- **File upload**: Supports up to 100MB file uploads

## Testing Configuration

Test nginx configuration:
```bash
docker-compose -f docker-compose.prod.yml exec nginx nginx -t
```

Reload nginx without downtime:
```bash
docker-compose -f docker-compose.prod.yml exec nginx nginx -s reload
```

## Troubleshooting

View nginx logs:
```bash
docker-compose -f docker-compose.prod.yml logs -f nginx
```

Common issues:
1. **502 Bad Gateway**: Blog service is not running or not healthy
2. **SSL certificate errors**: Check that certificate files exist and have correct permissions
3. **File upload fails**: Check `client_max_body_size` setting
