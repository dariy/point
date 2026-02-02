import tarfile
from pathlib import Path
from unittest.mock import patch

from app.services.backup_service import BackupService


def test_backup_service_init(tmp_path):
    with patch("app.services.backup_service.settings") as mock_settings:
        mock_settings.storage_path = str(tmp_path / "data")
        mock_settings.database_url = f"sqlite+aiosqlite:///{tmp_path}/data/blog.db"

        service = BackupService()
        assert service.backup_dir == tmp_path / "data" / "backups"
        assert service.backup_dir.exists()

def test_create_backup(tmp_path):
    # Setup data
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "blog.db").write_text("dummy db")
    media_dir = data_dir / "media"
    media_dir.mkdir()
    (media_dir / "test.jpg").write_text("dummy image")

    with patch("app.services.backup_service.settings") as mock_settings:
        mock_settings.storage_path = str(data_dir)
        mock_settings.database_url = f"sqlite+aiosqlite:///{data_dir}/blog.db"

        service = BackupService()
        backup_path = service.create_backup()

        assert Path(backup_path).exists()
        assert backup_path.endswith(".tar.gz")

        # Verify cleanup of temp files
        assert len(list(service.backup_dir.glob("temp_*"))) == 0

def test_list_backups(tmp_path):
    with patch("app.services.backup_service.settings") as mock_settings:
        mock_settings.storage_path = str(tmp_path / "data")
        mock_settings.database_url = "sqlite+aiosqlite:///./data/blog.db"

        service = BackupService()

        # Create dummy backups
        file1 = service.backup_dir / "backup_2026-01-01_10-00-00.tar.gz"
        file1.touch()

        file2 = service.backup_dir / "backup_2026-01-02_10-00-00.tar.gz"
        file2.touch()

        # Ensure file2 is newer
        import os
        import time
        now = time.time()
        os.utime(file1, (now - 100, now - 100))
        os.utime(file2, (now, now))

        backups = service.list_backups()
        assert len(backups) == 2
        assert backups[0]["filename"] == "backup_2026-01-02_10-00-00.tar.gz"  # Newest first

def test_delete_backup(tmp_path):
    with patch("app.services.backup_service.settings") as mock_settings:
        mock_settings.storage_path = str(tmp_path / "data")
        mock_settings.database_url = "sqlite+aiosqlite:///./data/blog.db"

        service = BackupService()
        filename = "backup_test.tar.gz"
        (service.backup_dir / filename).touch()

        assert service.delete_backup(filename) is True
        assert not (service.backup_dir / filename).exists()
        assert service.delete_backup("nonexistent") is False

def test_cleanup_old_backups(tmp_path):
    with patch("app.services.backup_service.settings") as mock_settings:
        mock_settings.storage_path = str(tmp_path / "data")
        mock_settings.database_url = "sqlite+aiosqlite:///./data/blog.db"

        service = BackupService()

        # Create old backup
        old_backup = service.backup_dir / "backup_old.tar.gz"
        old_backup.touch()
        # Set mtime to 60 days ago
        import time
        sixty_days_ago = time.time() - (60 * 86400)
        import os
        os.utime(old_backup, (sixty_days_ago, sixty_days_ago))

        # Create new backup
        new_backup = service.backup_dir / "backup_new.tar.gz"
        new_backup.touch()

        service.cleanup_old_backups(retention_days=30)

        assert not old_backup.exists()
        assert new_backup.exists()

def test_restore_backup(tmp_path):
    """Test restoring a backup."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    with patch("app.services.backup_service.settings") as mock_settings:
        mock_settings.storage_path = str(data_dir)
        mock_settings.database_url = f"sqlite+aiosqlite:///{data_dir}/blog.db"

        service = BackupService()

        # Create a backup archive manually
        backup_name = "backup_2026-01-01_10-00-00.tar.gz"
        backup_path = service.backup_dir / backup_name

        # Create temporary content for the backup
        temp_content = tmp_path / "backup_content"
        temp_content.mkdir()
        (temp_content / "blog.db").write_text("restored database")
        media_dir = temp_content / "media"
        media_dir.mkdir()
        (media_dir / "restored.jpg").write_text("restored image")

        # Create the tar.gz archive
        with tarfile.open(backup_path, "w:gz") as tar:
            tar.add(temp_content / "blog.db", arcname="blog.db")
            tar.add(temp_content / "media", arcname="media")

        # Create dummy current data
        (data_dir / "blog.db").write_text("current database")
        current_media = data_dir / "media"
        current_media.mkdir()
        (current_media / "current.jpg").write_text("current image")

        # Restore the backup
        service.restore_backup(backup_name)

        # Verify restoration
        assert (data_dir / "blog.db").read_text() == "restored database"
        assert (data_dir / "media" / "restored.jpg").read_text() == "restored image"
        assert not (data_dir / "media" / "current.jpg").exists()  # Old media removed

        # Verify cleanup of temp restore directory
        assert len(list(service.backup_dir.glob("restore_*"))) == 0

def test_restore_backup_invalid_filename(tmp_path):
    """Test that restore rejects invalid filenames."""
    with patch("app.services.backup_service.settings") as mock_settings:
        mock_settings.storage_path = str(tmp_path / "data")
        mock_settings.database_url = "sqlite+aiosqlite:///./data/blog.db"

        service = BackupService()

        # Test path traversal attempts
        import pytest
        with pytest.raises(ValueError, match="Invalid backup filename"):
            service.restore_backup("../etc/passwd")

        with pytest.raises(ValueError, match="Invalid backup filename"):
            service.restore_backup("backup/../../file.tar.gz")

def test_restore_backup_nonexistent(tmp_path):
    """Test that restore raises error for nonexistent backup."""
    with patch("app.services.backup_service.settings") as mock_settings:
        mock_settings.storage_path = str(tmp_path / "data")
        mock_settings.database_url = "sqlite+aiosqlite:///./data/blog.db"

        service = BackupService()

        import pytest
        with pytest.raises(FileNotFoundError):
            service.restore_backup("nonexistent.tar.gz")
