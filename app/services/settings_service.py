"""Settings service for managing blog configuration.

Handles storage and retrieval of settings with type conversion and fallback
to environment-based configuration.
"""

import json
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.settings import BlogSettings
from app.services.cache_service import clear_page_cache

logger = logging.getLogger(__name__)


class SettingsService:
    """Service for managing application settings."""

    def __init__(self, db: AsyncSession):
        """Initialize settings service.

        Args:
            db: Async database session
        """
        self.db = db
        self.app_settings = get_settings()

    def _convert_to_type(self, value: str | None, value_type: str) -> Any:
        """Convert string value from database to target type.

        Args:
            value: String value from DB
            value_type: Target type identifier

        Returns:
            Converted value
        """
        if value is None or value == "None":
            return None

        try:
            if value_type == "int":
                return int(value)
            if value_type == "bool":
                return value.lower() == "true"
            if value_type == "json":
                return json.loads(value)
            # Default to string
            return value
        except (ValueError, json.JSONDecodeError) as e:
            logger.error("Failed to convert setting value '%s' to %s: %s", value, value_type, e)
            return value

    def _convert_from_type(self, value: Any) -> tuple[str | None, str]:
        """Convert value to string for database storage.

        Args:
            value: Value of any supported type

        Returns:
            Tuple of (string_value, value_type)
        """
        if value is None:
            return None, "string"
        if isinstance(value, bool):
            return "true" if value else "false", "bool"
        if isinstance(value, int):
            return str(value), "int"
        if isinstance(value, dict | list):
            return json.dumps(value), "json"
        # Default to string
        return str(value), "string"

    async def get_setting(self, key: str) -> Any:
        """Get a single setting value.

        Checks database first, then falls back to environment settings.

        Args:
            key: Setting key

        Returns:
            Setting value
        """
        result = await self.db.execute(
            select(BlogSettings).where(BlogSettings.key == key)
        )
        db_setting = result.scalars().first()

        if db_setting:
            return self._convert_to_type(db_setting.value, db_setting.value_type)

        # Fallback to app settings (env)
        if hasattr(self.app_settings, key):
            return getattr(self.app_settings, key)

        return None

    async def get_all_settings(self) -> dict[str, Any]:
        """Get all settings, merging DB with environment defaults.

        Returns:
            Dictionary of all settings
        """
        # Get all settings from DB
        result = await self.db.execute(select(BlogSettings))
        db_settings = {s.key: self._convert_to_type(s.value, s.value_type) for s in result.scalars().all()}

        # Merge with env-based settings for specific blog-related keys
        blog_keys = [
            "blog_title", "blog_subtitle", "author_name", "author_email",
            "posts_per_page", "default_language", "default_theme",
            "show_view_counts", "enable_analytics", "google_analytics_id",
            "max_image_width", "jpeg_quality", "storage_quota_mb", "about_post_id",
            "thumbnail_width", "thumbnail_height", "use_thumbnails", "genai_api_endpoint"
        ]

        settings = {}
        for key in blog_keys:
            if key in db_settings:
                settings[key] = db_settings[key]
            elif hasattr(self.app_settings, key):
                settings[key] = getattr(self.app_settings, key)

        return settings

    async def update_setting(self, key: str, value: Any) -> None:
        """Update or create a setting.

        Args:
            key: Setting key
            value: Setting value
        """
        str_value, value_type = self._convert_from_type(value)

        result = await self.db.execute(
            select(BlogSettings).where(BlogSettings.key == key)
        )
        setting = result.scalars().first()

        if setting:
            setting.value = str_value
            setting.value_type = value_type
        else:
            setting = BlogSettings(key=key, value=str_value, value_type=value_type)
            self.db.add(setting)

        await self.db.flush()

        # Invalidate cache if important settings changed
        try:
            await clear_page_cache()
        except Exception as e:
            logger.warning("Failed to clear cache after settings update: %s", e)

    async def update_settings(self, settings_dict: dict[str, Any]) -> None:
        """Bulk update settings.

        Args:
            settings_dict: Dictionary of settings to update
        """
        for key, value in settings_dict.items():
            str_value, value_type = self._convert_from_type(value)

            result = await self.db.execute(
                select(BlogSettings).where(BlogSettings.key == key)
            )
            setting = result.scalars().first()

            if setting:
                setting.value = str_value
                setting.value_type = value_type
            else:
                setting = BlogSettings(key=key, value=str_value, value_type=value_type)
                self.db.add(setting)

        await self.db.flush()

        # Invalidate cache
        try:
            await clear_page_cache()
        except Exception as e:
            logger.warning("Failed to clear cache after bulk settings update: %s", e)
