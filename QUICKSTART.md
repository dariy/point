# Point — Quick Start

Point is a self-hosted personal photo blog designed for simplicity and privacy. It runs entirely in Docker (or Podman) and uses SQLite for storage, meaning no complex database setup or cloud dependencies are required—your data stays completely on your machine.

## One-Command Install

```bash
curl -fsSL https://short.darii.net/point-install | bash
```

The wizard will ask a few questions (all with sensible defaults — just hit Enter) and have Point running in minutes. See below for details and manual options.

---

## Requirements
- Docker (version 20+) or Podman installed on your server or NAS
- One port free (default: 8000)
- (Optional) An existing photo library directory you want to import

## Install in 3 Steps (manual)

If you prefer to run the steps yourself:

### Step 1: Download the files
```bash
mkdir point && cd point
curl -LO https://raw.githubusercontent.com/dariy/point/main/quickstart/docker-compose.yml
curl -LO https://raw.githubusercontent.com/dariy/point/main/quickstart/.env.example
cp .env.example .env
```

### Step 2: Start Point
```bash
docker compose up -d
```

### Step 3: First-run setup
Open `http://localhost:8000` in your browser. The setup wizard will appear — enter your username, password, and blog name to finish.

## Adding Your Photo Library

If you already have a collection of photos, you can easily import them:
1. Open your `.env` file in a text editor.
2. Uncomment and set `PHOTO_LIBRARY_PATH` to the location of your photos (e.g., `PHOTO_LIBRARY_PATH=/home/user/Photos`).
3. Restart the container: `docker compose up -d`.
4. Log into the Point admin panel, go to **Media**, and click **Scan for New Photos**.

Point copies these photos into its internal data directory; your original files are mounted as read-only and will never be modified.

## Updating Point

### Option A: Run the update script (easiest)
Point includes a script that auto-detects Docker or Podman and pulls the latest version. You can download it from the quickstart directory or run it directly:

```bash
sh update.sh
```

### Option B: Manual update
Alternatively, you can update manually using standard Compose commands:

```bash
docker compose pull && docker compose up -d
```

*Note: Point will show a notification in the admin panel whenever a new version is available.*

## Configuration

You can customize Point by editing the `.env` file.

| Variable | Default | Description |
| :--- | :--- | :--- |
| `DEPLOY_PORT` | `8000` | The host port Point listens on |
| `DATA_PATH` | `./data` | Directory where the database, photos, and backups are stored |
| `PHOTO_LIBRARY_PATH` | (None) | Path to your existing photo library (mounted read-only) |
| `SECRET_KEY` | (Auto) | Secret key for signing sessions (generated automatically if blank) |
| `GEMINI_API_KEY` | (Empty) | Your Google Gemini API key for AI-powered photo analysis |
| `LOG_LEVEL` | `INFO` | Logging detail level: DEBUG, INFO, WARN, or ERROR |
| `APP_NAME` | `Point` | The name of your blog displayed in the UI |
| `APP_ENV` | `development` | Set to `production` for live environments |
| `DEBUG` | `true` | Set to `false` in production environments |
| `MAX_UPLOAD_SIZE_MB` | `50` | Maximum allowed size for uploaded photos |
| `THUMBNAIL_WIDTH` | `400` | Width of generated thumbnails in pixels |
| `THUMBNAIL_HEIGHT` | `300` | Height of generated thumbnails in pixels |
| `JPEG_QUALITY` | `85` | Compression quality for JPEG images (1-100) |
| `SESSION_EXPIRY_HOURS` | `720` | How long an admin session remains valid |
| `SESSION_EXPIRY_PUBLIC_HOURS` | `24` | How long a public session remains valid |

## Data and Backups

- **Data Location:** All your data lives in `./data` (or your custom `DATA_PATH`). This is the only directory you need to back up to keep your blog safe.
- **Moving Servers:** To move Point, simply copy the `./data` folder, `docker-compose.yml`, and `.env` to the new machine and run `docker compose up -d`.
- **Built-in Backup:** Go to **Settings > Storage & System > Enable Backup** to create periodic snapshots automatically inside `./data/backups/`.

## Accessing the Admin Panel

You can manage your blog at: `http://your-server:8000/light`
Log in using the username and password you created during the first-run setup.

## Troubleshooting

1. **Port already in use:** Change `DEPLOY_PORT` in your `.env` file to a free port, then run `docker compose up -d`.
2. **Cannot reach Point from another machine:** Ensure your server's firewall allows traffic on the configured `DEPLOY_PORT`.
3. **Forgot your password:** There is currently no self-service reset. To reset manually, run `docker exec -it point /bin/sh` and use the internal CLI tool, or check [GitHub Issues](https://github.com/dariy/point/issues) for guidance.
4. **Container will not start:** Check the application logs for errors by running `docker logs point`.

## Getting Help

If you encounter bugs or have feature requests, please open an issue on GitHub:
[https://github.com/dariy/point/issues](https://github.com/dariy/point/issues)
