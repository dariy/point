# Point — Quick Start

Point is a self-hosted personal photo blog designed for simplicity and privacy. It runs entirely in Docker (or Podman) and uses SQLite for storage, meaning no complex database setup or cloud dependencies are required—your data stays completely on your machine.

## One-Command Install

```bash
# shortened
curl -fsSL https://short.point.photos/install | bash
```

```bash
# or direct
https://raw.githubusercontent.com/dariy/point/main/quickstart/install.sh
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
1. Open your `.env` file in a text editor and set `PHOTO_LIBRARY_PATH` to the location of your photos (e.g., `PHOTO_LIBRARY_PATH=/home/user/Photos`).
2. Open `docker-compose.yml` and uncomment the `PHOTO_LIBRARY_PATH=/photos` environment variable and its corresponding volume mount.
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
| `APP_URL` | (None) | The external URL of your blog (e.g., https://blog.example.com) |
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
| `HEAD_HTML` | *(empty)* | Extra HTML injected into `<head>` on public pages only (analytics, verification tags) — never sent to `/light` or authenticated requests |
| `CSP_SCRIPT_SRC` / `CSP_CONNECT_SRC` | *(empty)* | Extra origins appended to the Content-Security-Policy, for use with `HEAD_HTML` |

## Data and Backups

- **Data Location:** All your data lives in `./data` (or your custom `DATA_PATH`). This is the only directory you need to back up to keep your blog safe.
- **Moving Servers:** To move Point, simply copy the `./data` folder, `docker-compose.yml`, and `.env` to the new machine and run `docker compose up -d`.
- **Built-in Backup:** Go to **Settings > Storage & System > Enable Backup** to create periodic snapshots automatically inside `./data/backups/`.

## Accessing the Admin Panel

You can manage your blog at: `http://your-server:8000/light`
Log in using the username and password you created during the first-run setup.

## API Keys

Point supports long-lived, revocable API keys for programmatic access. These keys use Bearer authentication (`Authorization: Bearer <key>`) and can be used to interact with any protected route.

### Creating an API Key
- **Via UI:** API key management is available in the admin panel under **Settings > Security > API Keys** (Coming soon).
- **Via CLI (Bootstrap):** If you need an API key before accessing the UI, download
  [`create-api-key.sh`](quickstart/cli/create-api-key.sh) into your install directory
  (next to `docker-compose.yml`) and run:
  ```bash
  curl -fsSLO https://raw.githubusercontent.com/dariy/point/main/quickstart/cli/create-api-key.sh
  chmod +x create-api-key.sh
  ./create-api-key.sh "My Key Name"
  ```
  This will print a raw key (starting with `point_pat_`) exactly once. Save it securely.
  (Equivalent to `docker exec -it point ./point --create-api-key="My Key Name"`.)

### Using an API Key
Send the key in the `Authorization` header of your requests:
```bash
curl -H "Authorization: Bearer point_pat_..." http://localhost:8000/api/posts
```

## Comments on Posts (Optional)

Point bundles the [remark42](https://remark42.com) comment engine inside the same
container — no extra services to run. It stays dormant until configured.

### Enable in 3 steps

1. Set both values in your `.env` (then `docker compose up -d` to recreate):

   ```bash
   # Your blog's public URL + /comments
   REMARK_URL=https://blog.example.com/comments
   # Any long random string (e.g. `openssl rand -hex 32`)
   REMARK_SECRET=<random-string>
   ```

2. Restart: `docker compose up -d`
3. Turn on **Comments (Remark42)** in **Admin → Plugins**.

A comment box appears under every public post. Anonymous commenting is on by
default (`AUTH_ANON=true`); to require logins instead, set `AUTH_ANON=false` and
configure remark42 OAuth providers (`AUTH_GITHUB_CID`, …) in `.env` — see the
[remark42 docs](https://remark42.com/docs/configuration/authorization/).

### Moderation

- **Admin → Comments** (`/light/comments`): recent comments with delete and
  block-author actions, plus the blocked-users list — uses your normal Point
  login, nothing extra to set up.
- Optionally, moderate inside the widget itself: log into the widget via an
  OAuth provider and list that user's ID in the `ADMIN_SHARED_ID` env var.

### Notes

- Comment data (and remark42's automatic daily backups) live in
  `./data/remark42`, so your existing `./data` backup routine covers it.
- Toggling the plugin off hides the widget and 404s everything under
  `/comments` — the engine itself keeps idling inside the container (~40 MB).
- The engine is upgraded together with Point: each image update ships the
  then-current remark42 release.

## Instagram Cross-Posting (Optional)

Point can automatically publish your post photos to an Instagram Business or Creator
account when a post is published. You bring your own Meta app credentials — no shared
Point infrastructure is involved.

### Prerequisites

- An **Instagram Business or Creator account** (personal accounts cannot use the
  Content Publishing API)
- A **Meta Developer app** — create one at [developers.facebook.com](https://developers.facebook.com)
- `APP_URL` set in your `.env` to your blog's public HTTPS URL — Meta's servers must
  be able to reach your image URLs, so `localhost` will not work

### Quick setup

1. **Create a Meta app** — type **Business**, then add the **Instagram Graph API** product.
2. **Add permissions**: `instagram_basic` and `instagram_content_publish`.
   In Development mode these work without Meta app review for accounts added as
   testers/developers.
3. **Set the redirect URI** in your app's Facebook Login for Business settings:
   ```
   https://yourblog.example.com/api/instagram/callback
   ```
4. **Copy credentials** from App Settings → Basic into Point: go to
   **Settings → Instagram**, enter App ID and App Secret, and save.
5. **Connect**: toggle **Enable Instagram** on, then click **Connect Instagram**.
   You'll be redirected to Facebook OAuth and back to Settings on success.

Once connected, each post editor shows a **Share to Instagram** toggle and a
**Publish to Instagram now** button. The token (~60 days) refreshes automatically
when it's within 7 days of expiry.

For full details, including carousel publishing and caption templates, see
[docs/features/instagram-integration.md](docs/features/instagram-integration.md).

## Troubleshooting

1. **Port already in use:** Change `DEPLOY_PORT` in your `.env` file to a free port, then run `docker compose up -d`.
2. **Cannot reach Point from another machine:** Ensure your server's firewall allows traffic on the configured `DEPLOY_PORT`.
3. **Forgot your password:** If SMTP is configured (see below), use the "Forgot password?" link on the login page. Otherwise, reset it directly from the container: download
   [`change-password.sh`](quickstart/cli/change-password.sh) into your install directory
   (next to `docker-compose.yml`) and run:
   ```bash
   curl -fsSLO https://raw.githubusercontent.com/dariy/point/main/quickstart/cli/change-password.sh
   chmod +x change-password.sh
   ./change-password.sh --user="youruser" --password="newpassword"
   ```
   This resets the password directly in the database and logs out all existing sessions.
   (Equivalent to `docker exec -it point ./point reset-password --user="youruser" --password="newpassword"`.)
4. **Container will not start:** Check the application logs for errors by running `docker logs point`.

## Getting Help

If you encounter bugs or have feature requests, please open an issue on GitHub:
[https://github.com/dariy/point/issues](https://github.com/dariy/point/issues)
