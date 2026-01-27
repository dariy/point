"""System service for monitoring and maintenance tools.

Provides statistics collection, log viewing, and system-level operations
like cache clearing.
"""

import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.media import Media
from app.models.post import Post, PostStatus
from app.models.session import Session
from app.models.tag import Tag
from app.services.backup_service import BackupService
from app.services.cache_service import get_cache

logger = logging.getLogger(__name__)


class SystemService:
    """Service for system-level monitoring and tools."""

    def __init__(self, db: AsyncSession):
        """Initialize system service.

        Args:
            db: Async database session
        """
        self.db = db
        self.settings = get_settings()

    async def get_system_stats(self) -> dict[str, Any]:
        """Collect comprehensive system statistics.

        Returns:
            Dictionary with various system metrics
        """
        # Database size
        db_path = self.settings.database_url.replace("sqlite+aiosqlite:///", "")
        if db_path.startswith("./"):
            db_path = db_path[2:]
        db_file = Path(db_path)
        db_size_kb = 0
        if db_file.exists():
            db_size_kb = db_file.stat().st_size // 1024

        # Media stats
        media_count_result = await self.db.execute(select(func.count(Media.id)))
        media_count = media_count_result.scalar() or 0
        
        media_size_result = await self.db.execute(select(func.sum(Media.file_size)))
        total_media_size_bytes = media_size_result.scalar() or 0
        total_media_size_mb = round(total_media_size_bytes / (1024 * 1024), 2)

        # Content stats
        posts_count_result = await self.db.execute(
            select(func.count(Post.id)).where(Post.status == PostStatus.PUBLISHED)
        )
        posts_count = posts_count_result.scalar() or 0

        drafts_count_result = await self.db.execute(
            select(func.count(Post.id)).where(Post.status == PostStatus.DRAFT)
        )
        drafts_count = drafts_count_result.scalar() or 0

        tags_count_result = await self.db.execute(select(func.count(Tag.id)))
        tags_count = tags_count_result.scalar() or 0

        # Session stats
        sessions_count_result = await self.db.execute(
            select(func.count(Session.id)).where(Session.expires_at > datetime.now())
        )
        active_sessions_count = sessions_count_result.scalar() or 0

        # Cache stats
        cache = await get_cache()
        cache_stats = await cache.get_stats()
        cache_size_kb = cache_stats["total_size_bytes"] // 1024

        # Backup stats
        backup_service = BackupService()
        backups = backup_service.list_backups()
        backup_count = len(backups)
        last_backup_at = backups[0]["created_at"] if backups else None

        return {
            "database_size_kb": db_size_kb,
            "media_count": media_count,
            "total_media_size_mb": total_media_size_mb,
            "posts_count": posts_count,
            "drafts_count": drafts_count,
            "tags_count": tags_count,
            "active_sessions_count": active_sessions_count,
            "cache_size_kb": cache_size_kb,
            "backup_count": backup_count,
            "last_backup_at": last_backup_at,
        }

    def get_logs(self, log_type: str = "app", lines: int = 100) -> list[str]:
        """Read last N lines from a log file.

        Args:
            log_type: Type of log (app, error)
            lines: Number of lines to read

        Returns:
            List of log lines
        """
        log_dir = Path(self.settings.storage_path) / "logs"
        log_file = log_dir / f"{log_type}.log"

        if not log_file.exists():
            return [f"Log file {log_file} not found."]

        try:
            with open(log_file, "r") as f:
                # Efficiently read last N lines
                # For small files, this is fine
                content = f.readlines()
                return content[-lines:]
        except Exception as e:
            logger.error("Failed to read log file: %s", e)
            return [f"Error reading log: {e}"]

    async def clear_cache(self, pattern: str = "all") -> int:
        """Clear application cache.

        Args:
            pattern: Cache pattern to clear

        Returns:
            Number of cleared entries
        """
        cache = await get_cache()
        if pattern == "all":
            return await cache.clear_all()
        return await cache.clear_pattern(pattern)
