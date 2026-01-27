import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, status

from app.dependencies import require_auth
from app.models.user import User
from app.services.backup_service import BackupService

router = APIRouter(prefix="/api/system", tags=["System"])
logger = logging.getLogger(__name__)


@router.post("/backup")
async def create_manual_backup(_: User = Depends(require_auth)) -> dict:
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
