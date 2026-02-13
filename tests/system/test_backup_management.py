"""Tests for system backup and restore features."""

import asyncio
import os
import tarfile
from collections.abc import Generator
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from httpx import AsyncClient

from app.services.backup_service import BackupService


class TestBackupAPI:
    """Test cases for backup and restore API endpoints."""

    @pytest.mark.asyncio
    async def test_manual_backup_success(self, client: AsyncClient, auth_cookies: dict[str, str]) -> None:
        """Test successful manual backup triggering."""
        with patch("app.api.system.BackupService") as MockService:
            mock_instance = MockService.return_value
            mock_instance.create_backup.return_value = "/path/to/backup.tar.gz"
            response = await client.post("/api/system/backup", cookies=auth_cookies)
            assert response.status_code == 200
            assert response.json()["path"] == "/path/to/backup.tar.gz"

    @pytest.mark.asyncio
    async def test_backup_error_handling(self, client: AsyncClient, auth_cookies: dict[str, str]) -> None:
        """Test API error handling for backup failures."""
        with patch("app.api.system.BackupService") as MockService:
            mock_instance = MockService.return_value
            mock_instance.create_backup.side_effect = Exception("Disk full")
            response = await client.post("/api/system/backup", cookies=auth_cookies)
            assert response.status_code == 500

    @pytest.mark.asyncio
    async def test_list_backups_error(self, client: AsyncClient, auth_cookies: dict[str, str]) -> None:
        """Test list backups error handling."""
        with patch("app.api.system.BackupService") as MockService:
            mock_instance = MockService.return_value
            mock_instance.list_backups.side_effect = Exception("Storage failure")
            response = await client.get("/api/system/backups", cookies=auth_cookies)
            assert response.status_code == 500
            assert "Failed to list backups" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_restore_backup_success(self, client: AsyncClient, auth_cookies: dict[str, str]) -> None:
        """Test successful backup restoration."""
        future: asyncio.Future[None] = asyncio.Future()
        future.set_result(None)

        with patch("app.api.system.BackupService"), \
             patch("asyncio.BaseEventLoop.run_in_executor", return_value=future):
                response = await client.post("/api/system/backups/test.tar.gz/restore", cookies=auth_cookies)
                assert response.status_code == 200
                assert response.json()["status"] == "success"

    @pytest.mark.asyncio
    async def test_restore_backup_not_found(self, client: AsyncClient, auth_cookies: dict[str, str]) -> None:
        """Test restore endpoint with non-existent backup file."""
        with patch("app.api.system.BackupService") as MockService:
            mock_instance = MockService.return_value
            mock_instance.restore_backup.side_effect = FileNotFoundError("Missing")
            response = await client.post("/api/system/backups/missing.zip/restore", cookies=auth_cookies)
            assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_restore_backup_value_error(self, client: AsyncClient, auth_cookies: dict[str, str]) -> None:
        """Test restore backup with invalid filename (ValueError)."""
        with patch("asyncio.BaseEventLoop.run_in_executor", side_effect=ValueError("Invalid filename")):
            response = await client.post("/api/system/backups/invalid.tar.gz/restore", cookies=auth_cookies)
            assert response.status_code == 400
            assert "Invalid filename" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_restore_backup_generic_exception(
        self, client: AsyncClient, auth_cookies: dict[str, str]
    ) -> None:
        """Test generic Exception in restore_backup."""
        with patch(
            "app.api.system.BackupService.restore_backup",
            side_effect=Exception("Generic error"),
        ):
            response = await client.post(
                "/api/system/backups/test.zip/restore", cookies=auth_cookies
            )
            assert response.status_code == 500
            assert "Restore failed: Generic error" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_delete_backup_success(self, client: AsyncClient, auth_cookies: dict[str, str]) -> None:
        """Test successful backup deletion."""
        with patch("app.api.system.BackupService") as MockService:
            mock_instance = MockService.return_value
            mock_instance.delete_backup.return_value = True
            response = await client.delete("/api/system/backups/test.tar.gz", cookies=auth_cookies)
            assert response.status_code == 200
            assert response.json()["status"] == "success"

    @pytest.mark.asyncio
    async def test_delete_backup_not_found(self, client: AsyncClient, auth_cookies: dict[str, str]) -> None:
        """Test delete backup when file not found."""
        with patch("app.api.system.BackupService") as MockService:
            mock_instance = MockService.return_value
            mock_instance.delete_backup.return_value = False
            response = await client.delete("/api/system/backups/nonexistent.tar.gz", cookies=auth_cookies)
            assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_backup_generic_exception(
        self, client: AsyncClient, auth_cookies: dict[str, str]
    ) -> None:
        """Test generic Exception in delete_backup."""
        with patch(
            "app.api.system.BackupService.delete_backup",
            side_effect=Exception("Generic error"),
        ):
            response = await client.delete(
                "/api/system/backups/test.zip", cookies=auth_cookies
            )
            assert response.status_code == 500
            assert "Failed to delete backup: Generic error" in response.json()["detail"]


class TestBackupService:
    """Unit tests for BackupService business logic."""

    @pytest.fixture
    def mock_settings(self, tmp_path: Path) -> Generator[MagicMock, None, None]:
        """Fixture to mock settings with a temporary storage path."""
        with patch("app.services.backup_service.settings") as mock_settings:
            mock_settings.storage_path = str(tmp_path)
            mock_settings.database_url = "sqlite+aiosqlite:///./point.db"
            yield mock_settings

    def test_backup_service_init(self, mock_settings: MagicMock, tmp_path: Path) -> None:
        """Test BackupService initialization and path parsing."""
        # Test with ./ prefix
        mock_settings.database_url = "sqlite+aiosqlite:///./point.db"
        service = BackupService()
        assert service.backup_dir == tmp_path / "backups"
        assert service.db_path == Path("point.db")

        # Test without ./ prefix
        mock_settings.database_url = "sqlite+aiosqlite:///absolute/data/point.db"
        service = BackupService()
        assert service.db_path == Path("absolute/data/point.db")

    def test_create_backup_success(self, mock_settings: MagicMock, tmp_path: Path) -> None:
        """Test successful backup creation."""
        media_dir = tmp_path / "media"
        media_dir.mkdir()
        (media_dir / "test.txt").write_text("media content")

        db_file = tmp_path / "point.db"
        db_file.write_text("database content")

        mock_settings.database_url = f"sqlite+aiosqlite:///{db_file}"

        service = BackupService()
        service.media_dir = media_dir
        service.db_path = db_file

        backup_path_str = service.create_backup()
        backup_path = Path(backup_path_str)

        assert backup_path.exists()
        with tarfile.open(backup_path, "r:gz") as tar:
            names = tar.getnames()
            assert "point.db" in names
            assert "media/test.txt" in names

    def test_create_backup_unlink_on_failure(self, mock_settings: MagicMock, tmp_path: Path) -> None:
        """Test that the backup file is unlinked if an error occurs during archiving."""
        service = BackupService()
        dummy = tmp_path / "dummy.txt"
        dummy.write_text("dummy")
        service.db_path = dummy

        with patch("tarfile.TarFile.add", side_effect=Exception("Add failed")), \
             pytest.raises(Exception, match="Add failed"):
            service.create_backup()

        assert len(list(service.backup_dir.glob("backup_*.tar.gz"))) == 0

    def test_restore_backup_success(self, mock_settings: MagicMock, tmp_path: Path) -> None:
        """Test successful backup restoration with database and media."""
        service = BackupService()

        temp_source = tmp_path / "temp_source"
        temp_source.mkdir()
        (temp_source / "point.db").write_text("restored db")
        media_src = temp_source / "media"
        media_src.mkdir()
        (media_src / "img.jpg").write_text("restored image")

        backup_path = service.backup_dir / "restore_me.tar.gz"
        with tarfile.open(backup_path, "w:gz") as tar:
            tar.add(temp_source / "point.db", arcname="point.db")
            tar.add(media_src, arcname="media")

        service.db_path = tmp_path / "current.db"
        service.media_dir = tmp_path / "current_media"
        service.media_dir.mkdir()

        service.restore_backup("restore_me.tar.gz")

        assert service.db_path.read_text() == "restored db"
        assert (service.media_dir / "img.jpg").exists()

    def test_restore_backup_db_fallback(self, mock_settings: MagicMock, tmp_path: Path) -> None:
        """Test restore with old database filename (blog.db)."""
        service = BackupService()

        temp_source = tmp_path / "temp_source_old"
        temp_source.mkdir()
        (temp_source / "blog.db").write_text("old style db")

        backup_path = service.backup_dir / "restore_old.tar.gz"
        with tarfile.open(backup_path, "w:gz") as tar:
            tar.add(temp_source / "blog.db", arcname="blog.db")

        service.db_path = tmp_path / "point.db"
        service.restore_backup("restore_old.tar.gz")
        assert service.db_path.read_text() == "old style db"

    def test_cleanup_old_backups(self, mock_settings: MagicMock, tmp_path: Path) -> None:
        """Test deletion of backups older than retention period."""
        service = BackupService()
        now = datetime.now()

        new_backup = service.backup_dir / "backup_new.tar.gz"
        new_backup.write_text("new")

        old_backup = service.backup_dir / "backup_old.tar.gz"
        old_backup.write_text("old")
        old_time = (now - timedelta(days=31)).timestamp()
        os.utime(old_backup, (old_time, old_time))

        service.cleanup_old_backups(retention_days=30)

        assert new_backup.exists()
        assert not old_backup.exists()
