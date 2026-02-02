
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.scheduler_service import SchedulerService


def test_scheduler_init():
    with patch("app.services.scheduler_service.AsyncIOScheduler") as MockScheduler:
        SchedulerService()

        # Verify jobs added
        scheduler = MockScheduler.return_value
        assert scheduler.add_job.call_count == 3

        # Check specific jobs (approximate check based on call args)
        jobs = [call.kwargs.get('id') for call in scheduler.add_job.call_args_list]
        assert "cleanup_sessions" in jobs
        assert "flush_view_counts" in jobs
        assert "daily_backup" in jobs

def test_scheduler_lifecycle():
    with patch("app.services.scheduler_service.AsyncIOScheduler"):
        service = SchedulerService()

        service.start()
        service.scheduler.start.assert_called_once()

        service.shutdown()
        service.scheduler.shutdown.assert_called_once()

@pytest.mark.asyncio
async def test_tasks_execution():
    # Test wrapper methods execution
    service = SchedulerService()

    # Mock dependencies
    with patch("app.services.scheduler_service.async_session_maker") as mock_maker:
        mock_session = AsyncMock()
        mock_maker.return_value.__aenter__.return_value = mock_session

        with patch("app.services.scheduler_service.AuthService") as MockAuth:
            # Test cleanup_sessions
            await service.cleanup_sessions()
            MockAuth.return_value.cleanup_expired_sessions.assert_called_once()

        with patch("app.services.scheduler_service.PostService") as MockPost:
            # Test flush_view_counts
            await service.flush_view_counts()
            MockPost.flush_view_counts.assert_called_once()

    with patch("app.services.scheduler_service.BackupService"), \
         patch("asyncio.BaseEventLoop.run_in_executor", new_callable=AsyncMock) as mock_executor:
        # Test daily_backup
        # Since it runs in executor, we just want to ensure it calls the helper
        # or we can mock run_in_executor
        await service.daily_backup()
        mock_executor.assert_called_once()


@pytest.mark.asyncio
async def test_database_session_context_manager(db: AsyncSession):
    """Test database session works as context manager."""
    # The db fixture already uses the session
    # Just verify it works
    assert db is not None
    # Try a simple query
    result = await db.execute(text("SELECT 1"))
    assert result is not None


@pytest.mark.asyncio
async def test_scheduler_service_coverage():
    """Test scheduler service functions for coverage."""
    from app.services.scheduler_service import SchedulerService

    with patch("app.services.scheduler_service.AsyncIOScheduler") as mock_scheduler_cls:
        mock_scheduler = mock_scheduler_cls.return_value

        # Create scheduler
        scheduler = SchedulerService()

        # Start scheduler
        scheduler.start()
        mock_scheduler.start.assert_called_once()

        # Stop scheduler
        scheduler.shutdown()
        mock_scheduler.shutdown.assert_called_once()


@pytest.mark.asyncio
async def test_scheduler_cleanup_sessions():
    """Test cleanup_sessions task."""
    from app.services.scheduler_service import SchedulerService

    with patch("app.services.scheduler_service.AsyncIOScheduler"):
        scheduler = SchedulerService()

        # Mock auth service and session
        with patch("app.services.scheduler_service.async_session_maker") as mock_session_maker, \
             patch("app.services.scheduler_service.AuthService") as MockAuthService:

            mock_session = MagicMock()
            mock_session.__aenter__.return_value = mock_session
            mock_session_maker.return_value = mock_session

            mock_auth_service = MockAuthService.return_value
            mock_auth_service.cleanup_expired_sessions.return_value = 5

            await scheduler.cleanup_sessions()

            mock_auth_service.cleanup_expired_sessions.assert_called_once()


@pytest.mark.asyncio
async def test_scheduler_create_backup():
    """Test daily_backup task."""
    from app.services.scheduler_service import SchedulerService

    with patch("app.services.scheduler_service.AsyncIOScheduler"):
        scheduler = SchedulerService()

        with patch("app.services.scheduler_service.BackupService"), \
             patch("asyncio.get_running_loop") as mock_get_loop:

            mock_loop = MagicMock()
            mock_get_loop.return_value = mock_loop

            await scheduler.daily_backup()

            mock_loop.run_in_executor.assert_called_once()
