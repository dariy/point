"""Additional tests for MediaService coverage."""

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.services.media_service import MediaService
from app.models.media import Media, FileType
from datetime import datetime

@pytest.fixture
def media_service(db: AsyncSession):
    return MediaService(db)

@pytest.mark.asyncio
async def test_check_duplicate(media_service: MediaService, db: AsyncSession):
    """Test duplicate detection."""
    m = Media(
        filename="test.jpg", 
        original_path="p", 
        file_type=FileType.IMAGE, 
        mime_type="image/jpeg",
        file_size=100,
        checksum="dup_checksum"
    )
    db.add(m)
    await db.commit()
    
    found = await media_service._check_duplicate("dup_checksum")
    assert found is not None
    assert found.id == m.id
    
    assert await media_service._check_duplicate("none") is None

@pytest.mark.asyncio
async def test_calculate_storage_usage_empty(media_service: MediaService):
    """Test storage usage when empty."""
    usage = await media_service.calculate_storage_usage()
    assert usage == 0

@pytest.mark.asyncio
async def test_update_media_metadata(media_service: MediaService, db: AsyncSession):
    """Test updating media metadata."""
    m = Media(
        filename="test.jpg", 
        original_path="p", 
        file_type=FileType.IMAGE, 
        mime_type="image/jpeg",
        file_size=100,
        checksum="c"
    )
    db.add(m)
    await db.commit()
    
    updated = await media_service.update_media(m.id, alt_text="Alt", caption="Cap", post_id=1)
    assert updated.alt_text == "Alt"
    assert updated.caption == "Cap"
    assert updated.post_id == 1
    
    # Not found
    assert await media_service.update_media(999) is None

@pytest.mark.asyncio
async def test_cleanup_orphaned(media_service: MediaService, db: AsyncSession):
    """Test cleanup of orphaned media."""
    # We need to mock physical file existence or ensure they don't crash
    # MediaService uses aiofiles.os.remove which we can patch
    
    m1 = Media(filename="o1.jpg", original_path="o1.jpg", file_type=FileType.IMAGE, mime_type="i/j", file_size=10, checksum="c1", post_id=None)
    m2 = Media(filename="o2.jpg", original_path="o2.jpg", file_type=FileType.IMAGE, mime_type="i/j", file_size=20, checksum="c2", post_id=1)
    db.add_all([m1, m2])
    await db.commit()
    
    with pytest.MonkeyPatch().context() as m:
        # Prevent actual file deletion attempts
        m.setattr("aiofiles.os.remove", AsyncMock())
        m.setattr("pathlib.Path.exists", lambda x: False)
        
        deleted, freed = await media_service.cleanup_orphaned()
        assert deleted == 1
        assert freed == 10
        
        # Verify m1 is gone
        res = await db.execute(select(Media).where(Media.id == m1.id))
        assert res.scalars().first() is None

@pytest.mark.asyncio
async def test_get_storage_stats(media_service: MediaService, db: AsyncSession):
    """Test storage stats calculation."""
    m = Media(filename="s.jpg", original_path="s.jpg", file_type=FileType.IMAGE, mime_type="image/jpeg", file_size=1024*1024, checksum="cs")
    db.add(m)
    await db.commit()
    
    stats = await media_service.get_storage_stats()
    assert stats["total_files"] == 1
    assert stats["total_size_mb"] == 1.0
    assert "image" in stats["by_type"]

def test_get_media_urls(media_service: MediaService):
    """Test URL helper methods."""
    m = Media(original_path="orig.jpg", thumbnail_path="thumb.jpg")
    assert media_service.get_media_url(m) == "/media/orig.jpg"
    assert media_service.get_thumbnail_url(m) == "/media/thumb.jpg"
    
    m2 = Media(original_path="orig.jpg", thumbnail_path=None)
    assert media_service.get_thumbnail_url(m2) is None

def test_generate_unique_filename(media_service: MediaService):
    """Test unique filename generation."""
    name1 = media_service._generate_unique_filename("test.jpg")
    name2 = media_service._generate_unique_filename("test.jpg")
    assert name1 != name2
    assert name1.startswith("test_")
    assert name1.endswith(".jpg")

@pytest.mark.asyncio
async def test_get_storage_paths(media_service: MediaService):
    """Test storage path generation."""
    with pytest.MonkeyPatch().context() as m:
        m.setattr("app.services.media_service.ensure_directory", MagicMock())
        orig_f, thumb_f, orig_r, thumb_r = media_service._get_storage_paths("file.jpg", 2026, 1)
        assert "originals/2026/01/file.jpg" in str(orig_f)
        assert orig_r == "originals/2026/01/file.jpg"

@pytest.mark.asyncio
async def test_list_media_filters(media_service: MediaService, db: AsyncSession):
    """Test listing media with filters."""
    m1 = Media(filename="1.jpg", original_path="1.jpg", file_type=FileType.IMAGE, mime_type="i/j", file_size=10, checksum="c1", post_id=1)
    m2 = Media(filename="2.mp4", original_path="2.mp4", file_type=FileType.VIDEO, mime_type="v/m", file_size=20, checksum="c2", post_id=None)
    db.add_all([m1, m2])
    await db.commit()
    
    # Filter by type
    media, total = await media_service.list_media(file_type="video")
    assert len(media) == 1
    assert media[0].file_type == FileType.VIDEO
    
    # Filter by orphaned
    media, total = await media_service.list_media(orphaned_only=True)
    assert len(media) == 1
    assert media[0].post_id is None

from unittest.mock import MagicMock, AsyncMock


def test_storage_paths_format_for_quick_post(media_service: MediaService):
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


def test_storage_paths_with_different_months(media_service: MediaService):
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


def test_storage_paths_preserve_extension(media_service: MediaService):
    """Test that storage paths preserve file extensions."""
    with pytest.MonkeyPatch().context() as m:
        m.setattr("app.services.media_service.ensure_directory", MagicMock())

        extensions = [".jpg", ".png", ".gif", ".webp"]

        for ext in extensions:
            filename = f"test{ext}"
            _, _, orig_rel, _ = media_service._get_storage_paths(filename, 2026, 1)
            assert orig_rel.endswith(ext)
            assert filename in orig_rel


def test_storage_paths_no_duplicate_originals(media_service: MediaService):
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
