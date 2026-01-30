import asyncio
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app.database import async_session_maker
from app.services.auth_service import AuthService
from app.services.backup_service import BackupService
from app.services.post_service import PostService

logger = logging.getLogger(__name__)


class SchedulerService:
    def __init__(self):
        self.scheduler = AsyncIOScheduler()
        self._setup_jobs()

    def _setup_jobs(self):
        # Session Cleanup - Hourly
        self.scheduler.add_job(
            self.cleanup_sessions,
            "interval",
            hours=1,
            id="cleanup_sessions",
            replace_existing=True,
        )

        # View Count Flush - Every 30 minutes
        self.scheduler.add_job(
            self.flush_view_counts,
            "interval",
            minutes=30,
            id="flush_view_counts",
            replace_existing=True,
        )

        # Daily Backup - Daily at 3 AM
        self.scheduler.add_job(
            self.daily_backup,
            "cron",
            hour=3,
            minute=0,
            id="daily_backup",
            replace_existing=True,
        )

    def start(self):
        try:
            self.scheduler.start()
            logger.info("Scheduler started")
        except Exception as e:
            logger.error(f"Failed to start scheduler: {e}")

    def shutdown(self):
        try:
            self.scheduler.shutdown()
            logger.info("Scheduler shutdown")
        except Exception as e:
            logger.error(f"Failed to shutdown scheduler: {e}")

    async def cleanup_sessions(self):
        logger.info("Running scheduled task: cleanup_sessions")
        try:
            async with async_session_maker() as session:
                auth_service = AuthService(session)
                count = await auth_service.cleanup_expired_sessions()
                await session.commit()
                logger.info(f"Cleaned up {count} expired sessions")
        except Exception as e:
            logger.error(f"Error in cleanup_sessions task: {e}")

    async def flush_view_counts(self):
        logger.info("Running scheduled task: flush_view_counts")
        try:
            async with async_session_maker() as session:
                count = await PostService.flush_view_counts(session)
                # PostService.flush_view_counts commits internally
                logger.info(f"Flushed view counts for {count} posts")
        except Exception as e:
            logger.error(f"Error in flush_view_counts task: {e}")

    async def daily_backup(self):
        logger.info("Running scheduled task: daily_backup")
        loop = asyncio.get_running_loop()
        try:
            backup_service = BackupService()
            # Run in executor to avoid blocking main thread
            await loop.run_in_executor(None, self._run_backup, backup_service)
        except Exception as e:
            logger.error(f"Daily backup failed: {e}")

    def _run_backup(self, backup_service: BackupService):
        path = backup_service.create_backup()
        backup_service.cleanup_old_backups(retention_days=30)
        logger.info(f"Daily backup completed: {path}")
