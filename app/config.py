"""Application configuration management.

Uses Pydantic Settings for environment-based configuration with
validation and type coercion.
"""

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Application
    app_name: str = Field(default="PhotoBlog", description="Application name")
    app_env: Literal["development", "production", "testing"] = Field(
        default="development", description="Application environment"
    )
    debug: bool = Field(default=False, description="Debug mode")
    secret_key: str = Field(
        default="change-me-in-production",
        description="Secret key for signing tokens",
    )

    # Server
    host: str = Field(default="0.0.0.0", description="Server host")
    port: int = Field(default=8000, description="Server port")

    # Database
    database_url: str = Field(
        default="sqlite+aiosqlite:///./data/blog.db",
        description="Database connection URL",
    )

    # Storage
    storage_path: str = Field(default="./data", description="Base storage path")
    max_upload_size_mb: int = Field(default=10, description="Maximum upload size in MB")
    storage_quota_mb: int = Field(default=5000, description="Total storage quota in MB")
    max_image_width: int = Field(
        default=2560, description="Maximum image width in pixels"
    )
    jpeg_quality: int = Field(
        default=85, ge=1, le=100, description="JPEG compression quality"
    )
    thumbnail_width: int = Field(default=180, description="Thumbnail width")
    thumbnail_height: int = Field(default=120, description="Thumbnail height")
    avatar_size: int = Field(default=80, description="Avatar size (square)")

    # Blog Settings (defaults, can be overridden in DB)
    blog_title: str = Field(default="My Photo Blog", description="Blog title")
    blog_subtitle: str = Field(
        default="A personal photography journal", description="Blog subtitle"
    )
    author_name: str = Field(default="Photographer", description="Author name")
    author_email: str = Field(default="author@example.com", description="Author email")
    posts_per_page: int = Field(default=10, ge=1, le=100, description="Posts per page")
    default_language: str = Field(default="en", description="Default language")
    default_theme: Literal["auto", "dark", "light"] = Field(
        default="auto", description="Default theme"
    )

    # Security
    password_min_length: int = Field(
        default=8, ge=6, description="Minimum password length"
    )
    session_expiry_hours: int = Field(
        default=720, description="Session expiry in hours (default 30 days)"
    )
    session_expiry_public_hours: int = Field(
        default=2, description="Session expiry on public computers"
    )

    # Features
    enable_analytics: bool = Field(default=False, description="Enable analytics")
    google_analytics_id: str = Field(default="", description="Google Analytics ID")
    force_https: bool = Field(default=True, description="Force HTTPS redirects")
    show_view_counts: bool = Field(
        default=True, description="Show view counts on posts"
    )

    # Backup
    backup_enabled: bool = Field(default=True, description="Enable backups")
    backup_retention_days: int = Field(
        default=30, description="Backup retention in days"
    )

    # Caching
    cache_enabled: bool = Field(default=True, description="Enable page caching")
    cache_ttl_homepage: int = Field(
        default=300, ge=0, description="Homepage cache TTL in seconds (5 min)"
    )
    cache_ttl_post: int = Field(
        default=3600, ge=0, description="Single post cache TTL in seconds (1 hour)"
    )
    cache_ttl_tag: int = Field(
        default=600, ge=0, description="Tag page cache TTL in seconds (10 min)"
    )
    cache_ttl_feed: int = Field(
        default=1800, ge=0, description="RSS feed cache TTL in seconds (30 min)"
    )
    cache_ttl_sitemap: int = Field(
        default=3600, ge=0, description="Sitemap cache TTL in seconds (1 hour)"
    )

    @property
    def thumbnail_size(self) -> tuple[int, int]:
        """Get thumbnail size as tuple."""
        return (self.thumbnail_width, self.thumbnail_height)

    @property
    def max_upload_size_bytes(self) -> int:
        """Get maximum upload size in bytes."""
        return self.max_upload_size_mb * 1024 * 1024

    @property
    def storage_quota_bytes(self) -> int:
        """Get storage quota in bytes."""
        return self.storage_quota_mb * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance.

    Returns:
        Settings instance loaded from environment
    """
    return Settings()
