
import pytest
from unittest.mock import patch, MagicMock, AsyncMock
from app.services.scheduler_service import SchedulerService

def test_scheduler_init():
    with patch("app.services.scheduler_service.AsyncIOScheduler") as MockScheduler:
        service = SchedulerService()
        
        # Verify jobs added
        scheduler = MockScheduler.return_value
        assert scheduler.add_job.call_count == 3
        
        # Check specific jobs (approximate check based on call args)
        jobs = [call.kwargs.get('id') for call in scheduler.add_job.call_args_list]
        assert "cleanup_sessions" in jobs
        assert "flush_view_counts" in jobs
        assert "daily_backup" in jobs

def test_scheduler_lifecycle():
    with patch("app.services.scheduler_service.AsyncIOScheduler") as MockScheduler:
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
            
    with patch("app.services.scheduler_service.BackupService") as MockBackup:
        # Test daily_backup
        # Since it runs in executor, we just want to ensure it calls the helper
        # or we can mock run_in_executor
        with patch("asyncio.BaseEventLoop.run_in_executor", new_callable=AsyncMock) as mock_executor:
             await service.daily_backup()
             mock_executor.assert_called_once()
