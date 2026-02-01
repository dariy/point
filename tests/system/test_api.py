"""Tests for system API.
"""

from httpx import AsyncClient
from unittest.mock import patch
import pytest


@pytest.mark.asyncio
async def test_get_system_stats(client: AsyncClient, auth_cookies: dict):
    """Test getting system statistics."""
    response = await client.get("/api/system/stats", cookies=auth_cookies)
    assert response.status_code == 200
    data = response.json()
    assert "database_size_kb" in data
    assert "posts_count" in data
    assert "media_count" in data
    assert "cache_size_kb" in data
@pytest.mark.asyncio
async def test_get_logs(client: AsyncClient, auth_cookies: dict):
    """Test getting system logs."""
    # Note: Log files might not exist in test environment
    response = await client.get("/api/system/logs", cookies=auth_cookies)
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
@pytest.mark.asyncio
async def test_clear_cache(client: AsyncClient, auth_cookies: dict):
    """Test clearing cache."""
    response = await client.post("/api/system/cache/clear", cookies=auth_cookies)
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "success"
    assert "cleared_count" in data
@pytest.mark.asyncio
async def test_manual_backup(client: AsyncClient, auth_cookies: dict):
    """Test triggering a manual backup."""
    with patch("app.api.system.BackupService") as MockBackupService:
        mock_service = MockBackupService.return_value
        mock_service.create_backup.return_value = "/path/to/backup.tar.gz"
        response = await client.post(
            "/api/system/backup",
            cookies=auth_cookies
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "success"
        assert data["path"] == "/path/to/backup.tar.gz"
        mock_service.create_backup.assert_called_once()
        mock_service.cleanup_old_backups.assert_called_once()
@pytest.mark.asyncio
async def test_system_unauthorized(client: AsyncClient):
    """Test system endpoints without authentication."""
    endpoints = [
        ("/api/system/stats", "GET"),
        ("/api/system/logs", "GET"),
        ("/api/system/cache/clear", "POST"),
        ("/api/system/backup", "POST"),
    ]
    for url, method in endpoints:
        if method == "GET":
            response = await client.get(url)
        else:
            response = await client.post(url)
        assert response.status_code == 401