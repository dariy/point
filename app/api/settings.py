"""API endpoints for blog settings.
"""

from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
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


@router.post("/test-genai-connection")
async def test_genai_connection(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
) -> dict[str, Any]:
    """Test GenAI API endpoint connection.

    Returns:
        Connection test result with status and message
    """
    settings_service = SettingsService(db)
    endpoint = await settings_service.get_setting("genai_api_endpoint")

    if not endpoint:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="GenAI API endpoint not configured",
        )

    # Ensure endpoint ends with /
    if not endpoint.endswith("/"):
        endpoint = f"{endpoint}/"

    # Try to hit the healthcheck endpoint
    healthcheck_url = f"{endpoint}health"

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(healthcheck_url)

            if response.status_code == 200:
                return {
                    "status": "success",
                    "message": "Connection successful",
                    "endpoint": endpoint,
                    "response_data": response.json() if response.text else None,
                }
            else:
                return {
                    "status": "error",
                    "message": f"Server responded with status {response.status_code}",
                    "endpoint": endpoint,
                }

    except httpx.TimeoutException:
        return {
            "status": "error",
            "message": "Connection timeout - server did not respond within 5 seconds",
            "endpoint": endpoint,
        }
    except httpx.ConnectError:
        return {
            "status": "error",
            "message": "Connection refused - cannot reach the server",
            "endpoint": endpoint,
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Connection failed: {str(e)}",
            "endpoint": endpoint,
        }
