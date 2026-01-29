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
- `tests/`: Comprehensive test suite.
- `specification.md`: Detailed technical design.
- `phases.md`: Development roadmap and progress.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
