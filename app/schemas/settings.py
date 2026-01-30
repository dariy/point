"""Settings schemas for API validation.
"""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class SettingResponse(BaseModel):
    """Schema for a single setting response."""

    key: str
    value: Any
    value_type: str
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class SettingUpdate(BaseModel):
    """Schema for updating settings."""

    # We use a dict to support bulk updates
    settings: dict[str, Any]


class SystemStats(BaseModel):
    """Schema for system statistics."""

    app_version: str
    database_size_kb: int
    media_count: int
    total_media_size_mb: float
    posts_count: int
    drafts_count: int
    tags_count: int
    active_sessions_count: int
    cache_size_kb: int
    backup_count: int
    last_backup_at: datetime | None = None
