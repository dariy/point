import json
import time
from unittest.mock import patch

import pytest

from app.services.cache_service import CacheEntry, FileCache


@pytest.fixture
async def temp_cache(tmp_path):
    """Create a temporary FileCache."""
    cache = FileCache(tmp_path)
    await cache.initialize()
    return cache


@pytest.mark.asyncio
async def test_get_expired_entry(temp_cache):
    """Test retrieving an expired entry removes it."""
    # Create expired entry manually
    key = "expired_key"
    entry = CacheEntry(
        content="c", created_at=time.time() - 10, expires_at=time.time() - 5
    )

    path = temp_cache._get_cache_path(key)
    with open(path, "w") as f:
        json.dump(entry.to_dict(), f)

    result = await temp_cache.get(key)
    assert result is None
    # Should be deleted
    assert not path.exists()


@pytest.mark.asyncio
async def test_delete_os_error(temp_cache):
    """Test delete handles OSError."""
    with patch("aiofiles.os.remove", side_effect=OSError("Error")):
        # Ensure file exists so it tries to remove
        await temp_cache.set("key", "content")
        result = await temp_cache.delete("key")
        assert result is False


@pytest.mark.asyncio
async def test_clear_all_no_dir(tmp_path):
    """Test clear_all when directories don't exist."""
    # Initialize normally
    cache = FileCache(tmp_path)
    # Don't initialize, or remove dirs
    # If not initialized, dirs don't exist
    count = await cache.clear_all()
    assert count == 0


@pytest.mark.asyncio
async def test_clear_pattern_pages_os_error(temp_cache):
    """Test clear_pattern pages handles OSError."""
    await temp_cache.set("p1", "c")

    with patch("aiofiles.os.remove", side_effect=OSError("Error")):
        count = await temp_cache.clear_pattern("pages:*")
        assert count == 0


@pytest.mark.asyncio
async def test_clear_pattern_feeds_os_error(temp_cache):
    """Test clear_pattern feeds handles OSError."""
    await temp_cache.set("f1", "c", cache_type="feeds")

    with patch("aiofiles.os.remove", side_effect=OSError("Error")):
        count = await temp_cache.clear_pattern("feeds:*")
        assert count == 0


@pytest.mark.asyncio
async def test_cleanup_expired_corrupted_file(temp_cache):
    """Test cleanup handles corrupted files."""
    path = temp_cache.pages_dir / "corrupt.json"
    with open(path, "w") as f:
        f.write("{invalid json")

    count = await temp_cache.cleanup_expired()
    # Should delete the corrupted file
    assert count == 1
    assert not path.exists()


@pytest.mark.asyncio
async def test_cleanup_expired_non_json_file(temp_cache):
    """Test cleanup ignores non-json files."""
    path = temp_cache.pages_dir / "other.txt"
    with open(path, "w") as f:
        f.write("text")

    count = await temp_cache.cleanup_expired()
    assert count == 0
    assert path.exists()


@pytest.mark.asyncio
async def test_get_stats_os_error(temp_cache):
    """Test get_stats handles OSError during stat."""
    await temp_cache.set("p1", "c")

    with patch("aiofiles.os.stat", side_effect=OSError("Error")):
        stats = await temp_cache.get_stats()
        assert stats["pages"]["size_bytes"] == 0
