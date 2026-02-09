import logging
import shutil
import tarfile
from datetime import datetime
from pathlib import Path
from typing import Any

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


class BackupService:
    def __init__(self) -> None:
        self.backup_dir = Path(settings.storage_path) / "backups"
        self.backup_dir.mkdir(parents=True, exist_ok=True)

        # Parse database path from URL
        db_path = settings.database_url.replace("sqlite+aiosqlite:///", "")
        if db_path.startswith("./"):
            self.db_path = Path(db_path)
        else:
            self.db_path = Path(db_path)

        self.media_dir = Path(settings.storage_path) / "media"

    def create_backup(self) -> str:
        """Create a full backup of database and media files.

        Returns:
            Path to the backup archive
        """
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        backup_name = f"backup_{timestamp}"
        backup_path = self.backup_dir / f"{backup_name}.tar.gz"
        temp_dir = self.backup_dir / f"temp_{timestamp}"

        try:
            temp_dir.mkdir()

            # Backup database
            # For SQLite, it's safer to use the backup API or copy while locked,
            # but for this simple implementation, a copy is usually okay if traffic is low.
            # Ideally we would use the sqlite3 backup API.
            # Since we are in async context and might not have direct sqlite3 access easily without blocking,
            # we will do a file copy. To be safer, one might use 'sqlite3' command line.

            # Using shutil.copy2 for DB
            if self.db_path.exists():
                shutil.copy2(self.db_path, temp_dir / "point.db")

            # Backup media
            if self.media_dir.exists():
                shutil.copytree(self.media_dir, temp_dir / "media", dirs_exist_ok=True)

            # Create archive
            # Add contents of temp_dir directly (not the temp_dir itself)
            with tarfile.open(backup_path, "w:gz") as tar:
                for item in temp_dir.iterdir():
                    tar.add(item, arcname=item.name)

            logger.info(f"Backup created successfully: {backup_path}")
            return str(backup_path)

        except Exception as e:
            logger.error(f"Backup failed: {e}")
            if backup_path.exists():
                backup_path.unlink()
            raise
        finally:
            # Cleanup temp directory
            if temp_dir.exists():
                shutil.rmtree(temp_dir)

    def list_backups(self) -> list[dict[str, Any]]:
        """List available backups.

        Returns:
            List of dicts with backup info
        """
        backups = []
        for file in self.backup_dir.glob("backup_*.tar.gz"):
            stat = file.stat()
            backups.append(
                {
                    "filename": file.name,
                    "path": str(file),
                    "size": stat.st_size,
                    "created_at": datetime.fromtimestamp(stat.st_mtime),
                }
            )

        return sorted(backups, key=lambda x: x["created_at"], reverse=True)

    def delete_backup(self, filename: str) -> bool:
        """Delete a backup file.

        Args:
            filename: Name of the backup file

        Returns:
            True if deleted, False otherwise
        """
        file_path = self.backup_dir / filename
        if file_path.exists() and file_path.parent == self.backup_dir:
            file_path.unlink()
            return True
        return False

    def restore_backup(self, filename: str) -> None:
        """Restore a backup file.

        Args:
            filename: Name of the backup file to restore

        Raises:
            FileNotFoundError: If backup file doesn't exist
            ValueError: If filename is invalid
        """
        # Security: ensure filename is just a name, not a path
        if "/" in filename or "\\" in filename or ".." in filename:
            raise ValueError("Invalid backup filename")

        backup_path = self.backup_dir / filename
        if not backup_path.exists():
            raise FileNotFoundError(f"Backup file not found: {filename}")

        # Validate it's in the backup directory
        if backup_path.parent != self.backup_dir:
            raise ValueError("Backup file must be in backups directory")

        temp_dir = (
            self.backup_dir / f"restore_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        )

        try:
            temp_dir.mkdir()

            # Extract backup
            with tarfile.open(backup_path, "r:gz") as tar:
                tar.extractall(temp_dir)

            # Restore database
            db_backup = temp_dir / "point.db"
            if not db_backup.exists():
                # Fallback for older backups
                db_backup = temp_dir / "blog.db"

            if db_backup.exists():
                shutil.copy2(db_backup, self.db_path)
                logger.info("Database restored")

            # Restore media
            media_backup = temp_dir / "media"
            if media_backup.exists():
                # Remove existing media
                if self.media_dir.exists():
                    shutil.rmtree(self.media_dir)
                # Copy backup media
                shutil.copytree(media_backup, self.media_dir)
                logger.info("Media files restored")

            logger.info(f"Backup restored successfully from: {backup_path}")

        except Exception as e:
            logger.error(f"Restore failed: {e}")
            raise
        finally:
            # Cleanup temp directory
            if temp_dir.exists():
                shutil.rmtree(temp_dir)

    def cleanup_old_backups(self, retention_days: int = 30) -> None:
        """Delete backups older than retention_days.

        Args:
            retention_days: Number of days to keep backups
        """
        cutoff = datetime.now().timestamp() - (retention_days * 86400)

        for file in self.backup_dir.glob("backup_*.tar.gz"):
            if file.stat().st_mtime < cutoff:
                logger.info(f"Deleting old backup: {file.name}")
                file.unlink()
