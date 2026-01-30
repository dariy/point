import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import require_auth
from app.models.user import User
from app.schemas.settings import SystemStats
from app.services.backup_service import BackupService
from app.services.system_service import SystemService

router = APIRouter(prefix="/api/system", tags=["System"])
logger = logging.getLogger(__name__)


@router.get("/stats", response_model=SystemStats)
async def get_system_stats(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
) -> Any:
    """Get system statistics.

    Returns:
        System metrics
    """
    system_service = SystemService(db)
    return await system_service.get_system_stats()


@router.get("/logs")
async def get_logs(
    log_type: str = "app",
    lines: int = Query(100, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
) -> list[str]:
    """View system logs.

    Args:
        log_type: Type of log to view
        lines: Number of lines to return

    Returns:
        List of log lines
    """
    system_service = SystemService(db)
    return system_service.get_logs(log_type, lines)


@router.post("/cache/clear")
async def clear_cache(
    pattern: str = "all",
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
) -> dict[str, Any]:
    """Clear application cache.

    Args:
        pattern: Cache pattern to clear

    Returns:
        Number of entries cleared
    """
    system_service = SystemService(db)
    count = await system_service.clear_cache(pattern)
    return {"status": "success", "cleared_count": count}


@router.post("/backup")
async def create_manual_backup(_: User = Depends(require_auth)) -> dict[str, Any]:
    """Trigger a manual backup.

    Returns:
        Backup file path
    """
    loop = asyncio.get_running_loop()
    try:
        backup_service = BackupService()
        path = await loop.run_in_executor(None, backup_service.create_backup)

        # Also clean up old backups in background
        await loop.run_in_executor(None, backup_service.cleanup_old_backups)

        return {"status": "success", "path": path}
    except Exception as e:
        logger.error(f"Manual backup failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Backup failed: {str(e)}",
        )
