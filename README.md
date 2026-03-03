# Point

A modern, high-performance personal photo blog engine built with Go and Vanilla JS. Designed for photographers and visual storytellers who want a fast, self-hosted, and beautiful way to share their work.

## ✨ Key Features

- **🚀 High Performance**: Native Go backend (using Echo framework) and a lightweight Vanilla JS Single-Page Application (SPA).
- **🖼️ Media-Centric**: Automatic thumbnail generation, image resizing, and video support.
- **📱 Modern UX**:
    - **Immersive Mode**: Full-screen, distraction-free viewing for photo-heavy posts.
    - **SPA Navigation**: Instant page transitions via client-side routing.
    - **Gesture Support**: Swipe navigation for touch devices and carousels.
- **🌓 Dual Themes**: Beautiful dark and light modes with system preference detection.
- **🛠️ Professional Tools**:
    - Full post management with Markdown support.
    - **Quick Post Creation**: Drag-and-drop images into the editor or onto the page.
    - **Meta-tagging**: Hierarchical tag system with recursive post retrieval and counts.
    - Integrated backup/restore system.
    - System health and log monitoring.
- **🔒 Secure & Private**: Self-hosted, single-user authentication, and security-hardened headers.
- **📦 Single Container**: Easy deployment with Docker and SQLite.

## 🚀 Quick Start

### Prerequisites

- Docker and Docker Compose. Podman and Podman Compose as an alternative.
- (Optional) Go 1.25+ for local backend development.

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/dariy/point.git
   cd point
   ```

2. **Configure environment**:
   ```bash
   cp build/.env build/.env.local
   # Edit build/.env with your desired settings (SECRET_KEY is required in production)
   ```

3. **Build and start**:
   ```bash
   # Development (Podman)
   cd build && ./rebuild.sh

   # Production (Docker)
   cd build && docker compose up -d
   ```

The blog will be available at `http://localhost:8000`. The admin interface ("light") is at `http://localhost:8000/light/login`.

## ⚙️ Configuration

The application is configured via environment variables in the `.env` file. Key settings include:

- `APP_NAME`: Title of your blog.
- `SECRET_KEY`: Random string for session security.
- `STORAGE_PATH`: Directory for database and media storage (default: `/data`).
- `MAX_IMAGE_WIDTH`: Maximum width for uploaded images (auto-resized).
- `JPEG_QUALITY`: Quality setting for generated images (1-100).

## 📖 Usage Guide

### Quick Post Creation (Drag-and-Drop)

One of the standout features is the ability to create posts instantly by dragging images onto the page:

1. **Log in** to your blog at `/light/login`
2. **Browse** to any public page (homepage, single post, gallery, tags, etc.)
3. **Drag an image file** from your desktop onto the page
   - A full-screen drop zone overlay will appear
4. **Drop the image** to upload it
   - The image is automatically uploaded
   - You'll see an "Uploading..." indicator with the filename
5. **Automatic redirect** to the post editor
   - The image is pre-populated in the post content as a markdown reference
   - A preview of the uploaded image is displayed
   - You can immediately add a title, tags, and publish

**Supported formats**: JPG, PNG, GIF, WebP, SVG

**Benefits**:
- Skip the traditional "New Post → Upload Media → Insert" workflow
- Perfect for quick photo sharing while browsing your blog
- Seamlessly integrates content creation into your browsing experience

### Traditional Workflow

For a more traditional approach:

1. Go to `/light/posts/new`
2. Fill in post title and content
3. Upload media via the media library or drag-and-drop in the editor
4. Add tags
5. Save as draft or publish immediately

## 🛠️ Development

### Local Setup (Backend)

1. Navigate to the API directory:
   ```bash
   cd api
   ```

2. Install dependencies:
   ```bash
   go mod download
   ```

3. Run the development server:
   ```bash
   go run cmd/api/main.go
   ```

   The API will start on port 8000.

### Local Setup (Frontend)

The frontend is a static SPA served by the Go backend. During development, you can edit files in `frontend/` and refresh the browser.

### Tests & CSS

```bash
# Run all Go tests with coverage (from project root)
./scripts/run-tests.sh

# Rebuild CSS bundles after editing frontend/css/
./scripts/build-css.sh
```

## 📂 Project Structure

- `api/`: Go backend (Echo v4, sqlc, SQLite).
- `frontend/`: Vanilla JS SPA (no build step required).
- `build/`: Dockerfile, docker-compose, rebuild script.
- `data/`: Persistent storage (DB + media, mounted as volume).
- `docs/`: Architecture and feature documentation.
- `scripts/`: Test runner, CSS builder, backup utilities.

## 🚀 Production Deployment

1. **Clone** the repository on your server.
2. **Configure** `build/.env` — set `SECRET_KEY`, `APP_NAME`, `STORAGE_PATH`.
3. **Deploy**:
   ```bash
   cd build
   docker compose up -d
   ```

Your blog will be available at `http://your-server:8000`. Put it behind a reverse proxy (nginx/Caddy) for HTTPS.

See [`scripts/SETUP-PRODUCTION.md`](scripts/SETUP-PRODUCTION.md) for backup/restore setup.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

Built with:
- [Go](https://golang.org/) - Efficient and reliable backend language
- [Echo](https://echo.labstack.com/) - High performance, extensible Go web framework
- [Vanilla JS](https://developer.mozilla.org/en-US/docs/Web/JavaScript) - Framework-free component system
- [SQLite](https://sqlite.org/) - Self-contained, serverless database engine
- [Docker](https://www.docker.com/) / [Podman](https://podman.io/) - Containerization
