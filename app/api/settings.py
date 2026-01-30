"""API endpoints for blog settings.
"""

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import require_auth
from app.models.user import User
from app.schemas.settings import SettingUpdate
from app.services.settings_service import SettingsService

router = APIRouter(prefix="/api/settings", tags=["Settings"])


@router.get("")
async def get_all_settings(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
) -> dict[str, Any]:
    """Get all blog settings.

    Returns:
        Dictionary of all settings
    """
    settings_service = SettingsService(db)
    return await settings_service.get_all_settings()


@router.get("/{key}")
async def get_setting(
    key: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
) -> Any:
    """Get a specific blog setting.

    Args:
        key: Setting key
        db: Database session

    Returns:
        Setting value
    """
    settings_service = SettingsService(db)
    return await settings_service.get_setting(key)


@router.put("")
async def update_settings(
    settings_data: SettingUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
) -> dict[str, str]:
    """Update multiple blog settings.

    Args:
        settings_data: Dictionary of settings to update
        db: Database session

    Returns:
        Success status
    """
    settings_service = SettingsService(db)
    await settings_service.update_settings(settings_data.settings)
    return {"status": "success"}
