"""Additional tests for SystemService coverage."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from app.services.system_service import SystemService
from app.config import get_settings
from pathlib import Path
from unittest.mock import MagicMock, patch

@pytest.fixture
def system_service(db: AsyncSession):
    return SystemService(db)

@pytest.mark.asyncio
async def test_get_system_stats_db_path_prefixes(system_service: SystemService):
    """Test get_system_stats with various DB path formats."""
    # Mock settings.database_url
    with patch.object(system_service.settings, "database_url", "sqlite+aiosqlite:///./test.db"):
        stats = await system_service.get_system_stats()
        assert "database_size_kb" in stats

@pytest.mark.asyncio
async def test_get_logs_not_found(system_service: SystemService):
    """Test reading non-existent log file."""
    logs = system_service.get_logs("nonexistent")
    assert any("not found" in line for line in logs)

@pytest.mark.asyncio
async def test_get_logs_error(system_service: SystemService):
    """Test error handling when reading log file."""
    # Mock Path.exists to return True but open to fail
    with patch("pathlib.Path.exists", return_value=True):
        with patch("builtins.open", side_effect=Exception("Read Error")):
            logs = system_service.get_logs("app")
            assert any("Error reading log" in line for line in logs)

@pytest.mark.asyncio
async def test_clear_cache_pattern(system_service: SystemService):
    """Test clearing cache with specific pattern."""
    with patch("app.services.system_service.get_cache") as mock_get_cache:
        mock_cache = MagicMock()
        mock_cache.clear_pattern = AsyncMock(return_value=5)
        mock_get_cache.return_value = mock_cache
        
        cleared = await system_service.clear_cache("posts/*")
        assert cleared == 5
        mock_cache.clear_pattern.assert_called_with("posts/*")

from unittest.mock import AsyncMock
