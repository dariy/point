"""Tests for storage operations (stats, orphaned cleanup, paths, duplicates)."""

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.media import FileType, Media
from app.models.session import Session
from app.models.user import User
from app.services.auth_service import hash_token
from app.services.media_service import MediaService


@pytest.fixture
def media_service(db: AsyncSession):
    """Create media service instance."""
    return MediaService(db)


@pytest.fixture
async def light_auth_headers(client: AsyncClient, db: AsyncSession):
    """Create light user and return auth headers."""
    user = User(
        username="media_light",
        email="ma@test.com",
        password_hash="hash",
        display_name="Medialight",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    session = Session(
        user_id=user.id,
        token=hash_token("media-token"),
        expires_at=datetime.now(UTC) + timedelta(days=1),
        ip_address="127.0.0.1",
        user_agent="test",
    )
    db.add(session)
    await db.commit()
    return {"Cookie": "session_token=media-token"}


class TestStorageStats:
    """Test storage statistics endpoints."""

    @pytest.mark.asyncio
    async def test_stats_requires_auth(self, client: AsyncClient) -> None:
        """Test that stats requires authentication."""
        response = await client.get("/api/media/stats")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_stats_empty_storage(
        self, client: AsyncClient, light_auth_headers: dict
    ) -> None:
        """Test stats when storage is empty."""
        response = await client.get(
            "/api/media/stats",
            headers=light_auth_headers,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["total_files"] == 0
        assert data["total_size_bytes"] == 0
        assert "quota_bytes" in data
        assert "usage_percent" in data

    @pytest.mark.asyncio
    async def test_media_stats(self, client: AsyncClient, light_auth_headers):
        """Test media stats endpoint."""
        resp = await client.get("/api/media/stats", headers=light_auth_headers)
        assert resp.status_code == 200
        assert "total_size_mb" in resp.json()

    @pytest.mark.asyncio
    async def test_get_storage_stats(self, db: AsyncSession):
        """Test storage stats calculation."""
        service = MediaService(db)
        m = Media(
            filename="s.jpg",
            original_path="s.jpg",
            file_type=FileType.IMAGE,
            mime_type="image/jpeg",
            file_size=1024 * 1024,
            checksum="cs",
        )
        db.add(m)
        await db.commit()

        stats = await service.get_storage_stats()
        assert stats["total_files"] == 1
        assert stats["total_size_mb"] == 1.0
        assert "image" in stats["by_type"]

    @pytest.mark.asyncio
    async def test_calculate_storage_usage_empty(self, media_service: MediaService):
        """Test storage usage when empty."""
        usage = await media_service.calculate_storage_usage()
        assert usage == 0


class TestOrphanedMedia:
    """Test orphaned media detection and cleanup."""

    @pytest.mark.asyncio
    async def test_list_orphaned_requires_auth(self, client: AsyncClient) -> None:
        """Test that list orphaned requires authentication."""
        response = await client.get("/api/media/orphaned")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_list_orphaned_empty(
        self, client: AsyncClient, light_auth_headers: dict
    ) -> None:
        """Test listing orphaned media when none exists."""
        response = await client.get(
            "/api/media/orphaned",
            headers=light_auth_headers,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["media"] == []
        assert data["total"] == 0

    @pytest.mark.asyncio
    async def test_delete_orphaned_empty(
        self, client: AsyncClient, light_auth_headers: dict
    ) -> None:
        """Test deleting orphaned when none exists."""
        response = await client.delete(
            "/api/media/orphaned",
            headers=light_auth_headers,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["deleted_count"] == 0

    @pytest.mark.asyncio
    async def test_cleanup_orphaned(self, db: AsyncSession):
        """Test cleanup of orphaned media."""
        service = MediaService(db)
        # We need to mock physical file existence or ensure they don't crash
        # MediaService uses aiofiles.os.remove which we can patch

        # Use old timestamp to bypass grace period
        old_time = datetime.now(UTC) - timedelta(days=2)

        m1 = Media(
            filename="o1.jpg",
            original_path="o1.jpg",
            file_type=FileType.IMAGE,
            mime_type="i/j",
            file_size=10,
            checksum="c1",
            post_id=None,
            uploaded_at=old_time,
        )
        m2 = Media(
            filename="o2.jpg",
            original_path="o2.jpg",
            file_type=FileType.IMAGE,
            mime_type="i/j",
            file_size=20,
            checksum="c2",
            post_id=1,
            uploaded_at=old_time,
        )
        db.add_all([m1, m2])
        await db.commit()

        with pytest.MonkeyPatch().context() as m:
            # Prevent actual file deletion attempts
            m.setattr("aiofiles.os.remove", AsyncMock())
            m.setattr("pathlib.Path.exists", lambda x: False)

            deleted, freed = await service.cleanup_orphaned()
            assert deleted == 1
            assert freed == 10

            # Verify m1 is gone
            res = await db.execute(select(Media).where(Media.id == m1.id))
            assert res.scalars().first() is None

    @pytest.mark.asyncio
    async def test_cleanup_orphaned_grace_period(self, db: AsyncSession):
        """Test that media within grace period is not cleaned up."""
        service = MediaService(db)
        m1 = Media(
            filename="recent.jpg",
            original_path="recent.jpg",
            file_type=FileType.IMAGE,
            mime_type="i/j",
            file_size=10,
            checksum="crecent",
            post_id=None,
            uploaded_at=datetime.now(UTC) - timedelta(hours=1),
        )
        db.add(m1)
        await db.commit()

        deleted, freed = await service.cleanup_orphaned()
        assert deleted == 0
        assert freed == 0

    @pytest.mark.asyncio
    async def test_cleanup_orphaned_used_in_markdown(self, db: AsyncSession):
        """Test that media used in markdown is not cleaned up even if post_id is NULL."""
        from app.models.post import Post, PostStatus

        service = MediaService(db)

        # Create media
        old_time = datetime.now(UTC) - timedelta(days=2)
        m1 = Media(
            filename="used.jpg",
            original_path="originals/2026/02/used.jpg",
            file_type=FileType.IMAGE,
            mime_type="image/jpeg",
            file_size=50,
            checksum="cused",
            post_id=None,
            uploaded_at=old_time,
        )
        db.add(m1)

        # Create user for author_id
        user = User(
            username="author", email="a@t.com", password_hash="h", display_name="A"
        )
        db.add(user)
        await db.flush()

        # Create post referencing the media in markdown
        p = Post(
            title="Post",
            slug="post",
            content="Check this image: ![](/media/originals/2026/02/used.jpg)",
            author_id=user.id,
            status=PostStatus.PUBLISHED,
        )
        db.add(p)
        await db.commit()

        deleted, freed = await service.cleanup_orphaned()
        assert deleted == 0
        assert freed == 0

    @pytest.mark.asyncio
    async def test_cleanup_orphaned_success(self, db: AsyncSession):
        """Test cleanup orphaned deletes files."""
        service = MediaService(db)
        # Upload a file and then make it old
        media = await service.upload_file(b"clean me", "clean.mp4", "video/mp4")
        media.uploaded_at = datetime.now(UTC) - timedelta(days=2)
        await db.commit()

        count, bytes_freed = await service.cleanup_orphaned()
        assert count > 0
        assert bytes_freed > 0


class TestDuplicateDetection:
    """Test duplicate file detection."""

    @pytest.mark.asyncio
    async def test_check_duplicate(self, db: AsyncSession):
        """Test duplicate detection."""
        service = MediaService(db)
        m = Media(
            filename="test.jpg",
            original_path="p",
            file_type=FileType.IMAGE,
            mime_type="image/jpeg",
            file_size=100,
            checksum="dup_checksum",
        )
        db.add(m)
        await db.commit()

        found = await service._check_duplicate("dup_checksum")
        assert found is not None
        assert found.id == m.id

        assert await service._check_duplicate("none") is None


class TestStoragePaths:
    """Test storage path generation and formatting."""

    def test_get_media_urls(self, media_service: MediaService):
        """Test URL helper methods."""
        m = Media(original_path="orig.jpg", thumbnail_path="thumb.jpg")
        assert media_service.get_media_url(m) == "/media/orig.jpg"
        assert media_service.get_thumbnail_url(m) == "/media/thumb.jpg"

        m2 = Media(original_path="orig.jpg", thumbnail_path=None)
        assert media_service.get_thumbnail_url(m2) is None

    def test_generate_unique_filename(self, media_service: MediaService):
        """Test unique filename generation."""
        name1 = media_service._generate_unique_filename("test.jpg")
        name2 = media_service._generate_unique_filename("test.jpg")
        assert name1 != name2
        assert name1.startswith("test_")
        assert name1.endswith(".jpg")

    @pytest.mark.asyncio
    async def test_get_storage_paths(self, media_service: MediaService):
        """Test storage path generation."""
        with pytest.MonkeyPatch().context() as m:
            m.setattr("app.services.media_service.ensure_directory", MagicMock())
            orig_f, thumb_f, orig_r, thumb_r = media_service._get_storage_paths(
                "file.jpg", 2026, 1
            )
            assert "originals/2026/01/file.jpg" in orig_f.as_posix()
            assert orig_r == "originals/2026/01/file.jpg"

    def test_storage_paths_format_for_quick_post(self, media_service: MediaService):
        """Test that storage paths are formatted correctly for quick post creation."""
        with pytest.MonkeyPatch().context() as m:
            m.setattr("app.services.media_service.ensure_directory", MagicMock())
            orig, thumb, orig_rel, thumb_rel = media_service._get_storage_paths(
                "quick_post_test.jpg", 2026, 1
            )

            # Test original path format
            assert orig_rel.startswith("originals/")
            assert orig_rel == "originals/2026/01/quick_post_test.jpg"

            # Ensure no duplicate "originals" in path
            assert "originals/originals" not in orig_rel

            # Test thumbnail path format
            assert thumb_rel.startswith("thumbnails/")
            assert thumb_rel == "thumbnails/2026/01/quick_post_test.jpg"

    def test_storage_paths_with_different_months(self, media_service: MediaService):
        """Test storage paths for different months."""
        with pytest.MonkeyPatch().context() as m:
            m.setattr("app.services.media_service.ensure_directory", MagicMock())

            # January
            _, _, orig_jan, _ = media_service._get_storage_paths("test.jpg", 2026, 1)
            assert orig_jan == "originals/2026/01/test.jpg"

            # December
            _, _, orig_dec, _ = media_service._get_storage_paths("test.jpg", 2026, 12)
            assert orig_dec == "originals/2026/12/test.jpg"

            # Different year
            _, _, orig_2027, _ = media_service._get_storage_paths("test.jpg", 2027, 6)
            assert orig_2027 == "originals/2027/06/test.jpg"

    def test_storage_paths_preserve_extension(self, media_service: MediaService):
        """Test that storage paths preserve file extensions."""
        with pytest.MonkeyPatch().context() as m:
            m.setattr("app.services.media_service.ensure_directory", MagicMock())

            extensions = [".jpg", ".png", ".gif", ".webp"]

            for ext in extensions:
                filename = f"test{ext}"
                _, _, orig_rel, _ = media_service._get_storage_paths(filename, 2026, 1)
                assert orig_rel.endswith(ext)
                assert filename in orig_rel

    def test_storage_paths_no_duplicate_originals(self, media_service: MediaService):
        """Test that original_path never creates duplicate 'originals' directories.

        This is critical for the Quick Post Creation feature to work correctly.
        """
        with pytest.MonkeyPatch().context() as m:
            m.setattr("app.services.media_service.ensure_directory", MagicMock())

            # Test various filenames
            test_cases = [
                ("simple.jpg", "originals/2026/01/simple.jpg"),
                ("with-dash.png", "originals/2026/01/with-dash.png"),
                ("with_underscore.gif", "originals/2026/01/with_underscore.gif"),
                ("multi.word.file.jpg", "originals/2026/01/multi.word.file.jpg"),
            ]

            for filename, expected_path in test_cases:
                _, _, orig_rel, _ = media_service._get_storage_paths(filename, 2026, 1)
                assert orig_rel == expected_path
                # Critical: ensure no duplicate directories
                assert "originals/originals" not in orig_rel
                assert orig_rel.count("originals/") == 1
