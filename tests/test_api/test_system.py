
import pytest
from httpx import AsyncClient
from unittest.mock import patch, MagicMock

@pytest.mark.asyncio
async def test_manual_backup(client: AsyncClient, auth_cookies):
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
async def test_manual_backup_unauthorized(client: AsyncClient):
    response = await client.post("/api/system/backup")
    assert response.status_code == 401
