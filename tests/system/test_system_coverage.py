
from unittest.mock import patch

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_create_manual_backup_error(client: AsyncClient, auth_cookies: dict):
    """Test error handling in manual backup creation."""
    with patch("app.api.system.BackupService") as MockService:
        service_instance = MockService.return_value
        service_instance.create_backup.side_effect = Exception("Backup failed simulation")

        resp = await client.post("/api/system/backup", cookies=auth_cookies)
        assert resp.status_code == 500
        assert "Backup failed simulation" in resp.json()["detail"]

@pytest.mark.asyncio
async def test_list_backups_error(client: AsyncClient, auth_cookies: dict):
    """Test error handling in listing backups."""
    with patch("app.api.system.BackupService") as MockService:
        service_instance = MockService.return_value
        service_instance.list_backups.side_effect = Exception("List failed simulation")

        resp = await client.get("/api/system/backups", cookies=auth_cookies)
        assert resp.status_code == 500
        assert "List failed simulation" in resp.json()["detail"]

@pytest.mark.asyncio
async def test_restore_backup_not_found(client: AsyncClient, auth_cookies: dict):
    """Test restore backup file not found."""
    with patch("app.api.system.BackupService") as MockService:
        service_instance = MockService.return_value
        service_instance.restore_backup.side_effect = FileNotFoundError("File missing")

        resp = await client.post("/api/system/backups/missing.zip/restore", cookies=auth_cookies)
        assert resp.status_code == 404
        assert "File missing" in resp.json()["detail"]

@pytest.mark.asyncio
async def test_restore_backup_value_error(client: AsyncClient, auth_cookies: dict):
    """Test restore backup invalid value."""
    with patch("app.api.system.BackupService") as MockService:
        service_instance = MockService.return_value
        service_instance.restore_backup.side_effect = ValueError("Invalid format")

        resp = await client.post("/api/system/backups/bad.zip/restore", cookies=auth_cookies)
        assert resp.status_code == 400
        assert "Invalid format" in resp.json()["detail"]

@pytest.mark.asyncio
async def test_restore_backup_generic_error(client: AsyncClient, auth_cookies: dict):
    """Test restore backup generic error."""
    with patch("app.api.system.BackupService") as MockService:
        service_instance = MockService.return_value
        service_instance.restore_backup.side_effect = Exception("Restore explosion")

        resp = await client.post("/api/system/backups/bomb.zip/restore", cookies=auth_cookies)
        assert resp.status_code == 500
        assert "Restore explosion" in resp.json()["detail"]

@pytest.mark.asyncio
async def test_delete_backup_generic_error(client: AsyncClient, auth_cookies: dict):
    """Test delete backup generic error."""
    with patch("app.api.system.BackupService") as MockService:
        service_instance = MockService.return_value
        service_instance.delete_backup.side_effect = Exception("Delete failure")

        resp = await client.delete("/api/system/backups/file.zip", cookies=auth_cookies)
        assert resp.status_code == 500
        assert "Delete failure" in resp.json()["detail"]

@pytest.mark.asyncio
async def test_delete_backup_http_exception_pass_through(client: AsyncClient, auth_cookies: dict):
    """Test delete backup re-raises HTTPException (when not found)."""
    with patch("app.api.system.BackupService") as MockService:
        service_instance = MockService.return_value
        service_instance.delete_backup.return_value = False # Triggers 404 inside the route

        resp = await client.delete("/api/system/backups/missing.zip", cookies=auth_cookies)
        assert resp.status_code == 404
        assert "Backup file not found" in resp.json()["detail"]
