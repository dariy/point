import shutil
from pathlib import Path
from unittest.mock import patch, MagicMock
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