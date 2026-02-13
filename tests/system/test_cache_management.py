"""Tests for system caching features."""

import asyncio
import json
import time
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from httpx import AsyncClient

from app.services.cache_service import (
    CacheEntry,
    FileCache,
    clear_page_cache,
    get_cache,
    invalidate_cache_for_post,
    invalidate_cache_for_tag,
)


class TestCacheAPI:
    """Test cases for cache management API endpoints."""

    @pytest.mark.asyncio
    async def test_clear_cache(self, client: AsyncClient, auth_cookies: dict[str, str]) -> None:
        """Test clearing application cache via API."""
        response = await client.post("/api/system/cache/clear", cookies=auth_cookies)
        assert response.status_code == 200
        assert response.json()["status"] == "success"
        assert "cleared_count" in response.json()


class TestCacheEntry:
    """Tests for CacheEntry class."""

    def test_cache_entry_creation(self) -> None:
        """Test creating a cache entry."""
        entry = CacheEntry(
            content="<html>Test</html>",
            created_at=1000.0,
            expires_at=2000.0,
            content_type="text/html",
        )
        assert entry.content == "<html>Test</html>"
        assert entry.created_at == 1000.0
        assert entry.expires_at == 2000.0
        assert entry.content_type == "text/html"

    def test_cache_entry_is_expired(self) -> None:
        """Test checking if entry is expired."""
        now = time.time()
        entry = CacheEntry(
            content="test",
            created_at=now,
            expires_at=now + 3600,  # 1 hour from now
        )
        assert not entry.is_expired()
        expired_entry = CacheEntry(
            content="test",
            created_at=now - 7200,
            expires_at=now - 3600,  # 1 hour ago
        )
        assert expired_entry.is_expired()

    def test_cache_entry_serialization(self) -> None:
        """Test CacheEntry to_dict and from_dict."""
        data = {
            "content": "test",
            "created_at": 100.0,
            "expires_at": 200.0,
            "content_type": "application/xml"
        }
        entry = CacheEntry.from_dict(data)
        assert entry.content == "test"
        assert entry.content_type == "application/xml"
        assert entry.to_dict() == data


class TestFileCache:
    """Tests for FileCache implementation."""

    @pytest.mark.asyncio
    async def test_initialize_creates_directories(self, tmp_path: Path) -> None:
        """Test that initialize creates necessary cache directories."""
        cache_dir = tmp_path / "test_cache"
        cache = FileCache(cache_dir)
        await cache.initialize()
        assert (cache_dir / "pages").exists()
        assert (cache_dir / "feeds").exists()

    @pytest.mark.asyncio
    async def test_key_generation(self, cache: FileCache) -> None:
        """Test cache key generation logic."""
        # Simple URL
        k1 = cache._generate_key("/url")
        assert len(k1) == 32

        # URL with params
        k2 = cache._generate_key("/url", {"a": 1, "b": 2})
        k3 = cache._generate_key("/url", {"b": 2, "a": 1})
        assert k2 == k3
        assert k1 != k2

    @pytest.mark.asyncio
    async def test_set_and_get(self, cache: FileCache) -> None:
        """Test basic set and get operations."""
        await cache.set("test_key", "<html>Test</html>", ttl=3600)
        entry = await cache.get("test_key")
        assert entry is not None
        assert entry.content == "<html>Test</html>"

    @pytest.mark.asyncio
    async def test_get_by_url_and_set_by_url(self, cache: FileCache) -> None:
        """Test URL-based operations."""
        url = "/test-url"
        params: dict[str, Any] = {"q": "search"}
        content = "html content"

        await cache.set_by_url(url, content, query_params=params, ttl=100)
        entry = await cache.get_by_url(url, query_params=params)
        assert entry is not None
        assert entry.content == content

    @pytest.mark.asyncio
    async def test_get_missing_and_corrupted(self, cache: FileCache) -> None:
        """Test retrieval of missing or corrupted files."""
        assert await cache.get("nonexistent") is None

        # Corrupted JSON
        path = cache._get_cache_path("corrupted")
        path.write_text("invalid json")
        assert await cache.get("corrupted") is None

        # Missing data keys
        path.write_text('{"wrong": "data"}')
        assert await cache.get("corrupted") is None

    @pytest.mark.asyncio
    async def test_get_expired_entry_auto_cleanup(self, cache: FileCache) -> None:
        """Test that retrieving an expired entry automatically removes it."""
        key = "expired_key"
        entry = CacheEntry(content="c", created_at=time.time()-10, expires_at=time.time()-5)
        path = cache._get_cache_path(key)
        path.write_text(json.dumps(entry.to_dict()))

        result = await cache.get(key)
        assert result is None
        assert not path.exists()

    @pytest.mark.asyncio
    async def test_delete_operations(self, cache: FileCache) -> None:
        """Test deleting entries from cache."""
        await cache.set("k1", "c")
        assert await cache.delete("k1") is True
        assert await cache.delete("k1") is False # Already gone

        await cache.set_by_url("/url", "c")
        assert await cache.delete_by_url("/url") is True

    @pytest.mark.asyncio
    async def test_clear_all(self, cache: FileCache) -> None:
        """Test clearing all cache entries."""
        await cache.set("key1", "content1")
        await cache.set("feed1", "feed_content", cache_type="feeds")
        count = await cache.clear_all()
        assert count == 2
        assert await cache.get("key1") is None

        # Handle non-existent directories
        new_cache = FileCache(Path("/tmp/nonexistent_cache_dir_999"))
        assert await new_cache.clear_all() == 0

    @pytest.mark.asyncio
    async def test_clear_pattern(self, cache: FileCache) -> None:
        """Test pattern-based cache clearing."""
        await cache.set("p1", "content", cache_type="pages")
        await cache.set("f1", "content", cache_type="feeds")

        assert await cache.clear_pattern("pages:*") == 1
        assert await cache.get("p1") is None
        assert await cache.get("f1", cache_type="feeds") is not None

        assert await cache.clear_pattern("feeds:*") == 1
        assert await cache.get("f1", cache_type="feeds") is None

        await cache.set("p2", "content")
        # Pattern 'other' triggers clear_all() in current implementation
        assert await cache.clear_pattern("other") == 1
        assert await cache.get("p2") is None

    @pytest.mark.asyncio
    async def test_cleanup_expired_exhaustive(self, cache: FileCache) -> None:
        """Test periodic cleanup of expired and corrupted entries."""
        now = time.time()

        # Expired
        path1 = cache._get_cache_path("expired")
        path1.write_text(json.dumps(CacheEntry("c", now-10, now-5).to_dict()))

        # Corrupted
        path2 = cache._get_cache_path("corrupted")
        path2.write_text("not json")

        # Fresh
        await cache.set("fresh", "c", ttl=100)

        # Non-JSON file
        path4 = cache.pages_dir / "readme.txt"
        path4.write_text("ignore me")

        assert await cache.cleanup_expired() == 2
        assert not path1.exists()
        assert not path2.exists()
        assert path4.exists()

        # Test OS error during cleanup (line 392-393)
        path5 = cache._get_cache_path("error_on_remove")
        path5.write_text("not json")
        with patch("aiofiles.os.remove", side_effect=OSError()):
            # cleanup_expired has a catch-all OSError for removal
            await cache.cleanup_expired()

    @pytest.mark.asyncio
    async def test_cleanup_expired_missing_dir(self, tmp_path: Path) -> None:
        """Test cleanup_expired when directories don't exist (line 372)."""
        cache = FileCache(tmp_path / "never_created")
        # directories are NOT created by __init__
        assert await cache.cleanup_expired() == 0

    @pytest.mark.asyncio
    async def test_stats_missing_dir(self, tmp_path: Path) -> None:
        """Test get_stats when directories don't exist (lines 408, 418)."""
        cache = FileCache(tmp_path / "never_created")
        stats = await cache.get_stats()
        assert stats["total_entries"] == 0
        assert stats["total_size_bytes"] == 0

    @pytest.mark.asyncio
    async def test_stats_and_hit_rate(self, cache: FileCache) -> None:
        """Test cache statistics and hit rate calculation."""
        await cache.set("p1", "c")
        await cache.set("f1", "c", cache_type="feeds")

        await cache.get("p1") # Hit
        await cache.get("missing") # Miss

        stats = await cache.get_stats()
        assert stats["hits"] == 1
        assert stats["misses"] == 1
        assert stats["hit_rate_percent"] == 50.0
        assert stats["pages"]["count"] == 1
        assert stats["feeds"]["count"] == 1

    @pytest.mark.asyncio
    async def test_concurrent_access(self, cache: FileCache) -> None:
        """Test concurrent cache operations safety."""
        async def set_entry(key: str) -> None:
            await cache.set(key, f"content_{key}")

        await asyncio.gather(*[set_entry(f"key_{i}") for i in range(10)])

        for i in range(10):
            entry = await cache.get(f"key_{i}")
            assert entry is not None
            assert entry.content == f"content_key_{i}"


class TestGlobalCacheFunctions:
    """Tests for global singleton and convenience functions."""

    @pytest.mark.asyncio
    async def test_singleton_lifecycle(self, tmp_path: Path) -> None:
        """Test the get_cache singleton pattern."""
        from app.config import get_settings
        settings = get_settings()

        with patch.object(settings, "storage_path", str(tmp_path)), \
             patch("app.services.cache_service._cache", None):
                c1 = await get_cache()
                c2 = await get_cache()
                assert c1 is c2
                assert c1.cache_dir.name == "cache"

    @pytest.mark.asyncio
    async def test_convenience_invalidators(self, tmp_path: Path) -> None:
        """Test post/tag specific invalidation functions."""
        from app.config import get_settings
        settings = get_settings()

        with patch.object(settings, "storage_path", str(tmp_path)), \
             patch("app.services.cache_service._cache", None):
                cache = await get_cache()
                await cache.set("key", "val")

                await invalidate_cache_for_post()
                assert await cache.get("key") is None

                await cache.set("key", "val")
                await invalidate_cache_for_tag()
                assert await cache.get("key") is None

                await cache.set("key", "val")
                await clear_page_cache()
                assert await cache.get("key") is None


class TestCacheErrorHandling:
    """Tests for OS-level error handling in cache operations."""

    @pytest.mark.asyncio
    async def test_file_system_errors(self, cache: FileCache) -> None:
        """Test resilience against file system permissions/errors."""
        # delete error
        with patch("aiofiles.os.path.exists", return_value=True), \
             patch("aiofiles.os.remove", side_effect=OSError()):
                assert await cache.delete("any") is False

        # stat error in get_stats
        await cache.set("p1", "c")
        with patch("aiofiles.os.stat", side_effect=OSError()):
            stats = await cache.get_stats()
            assert stats["pages"]["size_bytes"] == 0
