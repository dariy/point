"""Tests for cache service.

Tests the FileCache class and cache invalidation functions.
"""

import asyncio
import time

import pytest

from app.services.cache_service import CacheEntry, FileCache


class TestCacheEntry:
    """Tests for CacheEntry class."""

    def test_cache_entry_creation(self):
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

    def test_cache_entry_is_expired(self):
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

    def test_cache_entry_to_dict(self):
        """Test converting entry to dictionary."""
        entry = CacheEntry(
            content="test",
            created_at=1000.0,
            expires_at=2000.0,
            content_type="text/html",
        )
        data = entry.to_dict()
        assert data["content"] == "test"
        assert data["created_at"] == 1000.0
        assert data["expires_at"] == 2000.0
        assert data["content_type"] == "text/html"

    def test_cache_entry_from_dict(self):
        """Test creating entry from dictionary."""
        data = {
            "content": "test",
            "created_at": 1000.0,
            "expires_at": 2000.0,
            "content_type": "application/xml",
        }
        entry = CacheEntry.from_dict(data)
        assert entry.content == "test"
        assert entry.created_at == 1000.0
        assert entry.expires_at == 2000.0
        assert entry.content_type == "application/xml"


class TestFileCache:
    """Tests for FileCache class."""

    @pytest.fixture
    async def cache(self, tmp_path):
        """Create a temporary cache for testing."""
        cache = FileCache(tmp_path / "cache")
        await cache.initialize()
        return cache

    @pytest.mark.asyncio
    async def test_initialize_creates_directories(self, tmp_path):
        """Test that initialize creates cache directories."""
        cache_dir = tmp_path / "test_cache"
        cache = FileCache(cache_dir)
        await cache.initialize()
        assert (cache_dir / "pages").exists()
        assert (cache_dir / "feeds").exists()

    @pytest.mark.asyncio
    async def test_generate_key(self, cache):
        """Test cache key generation."""
        # Same URL should produce same key
        key1 = cache._generate_key("/")
        key2 = cache._generate_key("/")
        assert key1 == key2
        key3 = cache._generate_key("/posts/test")
        assert key1 != key3
        key4 = cache._generate_key("/", {"page": 2})
        assert key1 != key4

    @pytest.mark.asyncio
    async def test_set_and_get(self, cache):
        """Test setting and getting cached values."""
        await cache.set("test_key", "<html>Test</html>", ttl=3600)
        entry = await cache.get("test_key")
        assert entry is not None
        assert entry.content == "<html>Test</html>"
        assert entry.content_type == "text/html"

    @pytest.mark.asyncio
    async def test_set_and_get_by_url(self, cache):
        """Test setting and getting cached values by URL."""
        await cache.set_by_url("/", "<html>Home</html>", ttl=3600)
        entry = await cache.get_by_url("/")
        assert entry is not None
        assert entry.content == "<html>Home</html>"

    @pytest.mark.asyncio
    async def test_get_nonexistent_key(self, cache):
        """Test getting a nonexistent key returns None."""
        entry = await cache.get("nonexistent")
        assert entry is None

    @pytest.mark.asyncio
    async def test_get_expired_entry_returns_none(self, cache):
        """Test that expired entries return None."""
        # Set with very short TTL
        await cache.set("expired_key", "content", ttl=0)
        await asyncio.sleep(0.1)
        entry = await cache.get("expired_key")
        assert entry is None

    @pytest.mark.asyncio
    async def test_delete(self, cache):
        """Test deleting cached values."""
        await cache.set("to_delete", "content")
        assert await cache.get("to_delete") is not None
        result = await cache.delete("to_delete")
        assert result is True
        assert await cache.get("to_delete") is None

    @pytest.mark.asyncio
    async def test_delete_nonexistent(self, cache):
        """Test deleting nonexistent key returns False."""
        result = await cache.delete("nonexistent")
        assert result is False

    @pytest.mark.asyncio
    async def test_clear_all(self, cache):
        """Test clearing all cache entries."""
        # Set some entries
        await cache.set("key1", "content1")
        await cache.set("key2", "content2")
        await cache.set("feed1", "feed_content", cache_type="feeds")
        count = await cache.clear_all()
        assert count == 3
        assert await cache.get("key1") is None
        assert await cache.get("key2") is None
        assert await cache.get("feed1", cache_type="feeds") is None

    @pytest.mark.asyncio
    async def test_clear_pattern_pages(self, cache):
        """Test clearing pages cache by pattern."""
        await cache.set("page1", "content1")
        await cache.set("feed1", "feed_content", cache_type="feeds")
        count = await cache.clear_pattern("pages:*")
        assert count == 1
        assert await cache.get("page1") is None
        # Feeds should remain
        assert await cache.get("feed1", cache_type="feeds") is not None

    @pytest.mark.asyncio
    async def test_clear_pattern_feeds(self, cache):
        """Test clearing feeds cache by pattern."""
        await cache.set("page1", "content1")
        await cache.set("feed1", "feed_content", cache_type="feeds")
        count = await cache.clear_pattern("feeds:*")
        assert count == 1
        assert await cache.get("page1") is not None
        # Feeds should be cleared
        assert await cache.get("feed1", cache_type="feeds") is None

    @pytest.mark.asyncio
    async def test_cleanup_expired(self, cache):
        """Test cleaning up expired entries."""
        # Set entries with different TTLs
        await cache.set("fresh", "content", ttl=3600)
        await cache.set("expired", "content", ttl=0)
        await asyncio.sleep(0.1)
        count = await cache.cleanup_expired()
        assert count == 1
        assert await cache.get("fresh") is not None

    @pytest.mark.asyncio
    async def test_get_stats(self, cache):
        """Test getting cache statistics."""
        # Set some entries
        await cache.set("page1", "content1")
        await cache.set("feed1", "feed_content", cache_type="feeds")
        await cache.get("page1")  # Hit
        await cache.get("nonexistent")  # Miss
        stats = await cache.get_stats()
        assert stats["pages"]["count"] == 1
        assert stats["feeds"]["count"] == 1
        assert stats["total_entries"] == 2
        assert stats["hits"] == 1
        assert stats["misses"] == 1
        assert stats["sets"] == 2
        assert "hit_rate_percent" in stats

    @pytest.mark.asyncio
    async def test_clear_for_post_change(self, cache):
        """Test cache invalidation for post changes."""
        await cache.set("page1", "content1")
        await cache.set("feed1", "feed_content", cache_type="feeds")
        count = await cache.clear_for_post_change()
        assert count == 2

    @pytest.mark.asyncio
    async def test_clear_for_tag_change(self, cache):
        """Test cache invalidation for tag changes."""
        await cache.set("page1", "content1")
        await cache.set("feed1", "feed_content", cache_type="feeds")
        count = await cache.clear_for_tag_change()
        assert count == 2

    @pytest.mark.asyncio
    async def test_cache_with_query_params(self, cache):
        """Test caching with different query parameters."""
        # Same URL, different query params
        await cache.set_by_url("/", "page 1", query_params={"page": 1})
        await cache.set_by_url("/", "page 2", query_params={"page": 2})
        entry1 = await cache.get_by_url("/", {"page": 1})
        entry2 = await cache.get_by_url("/", {"page": 2})
        assert entry1.content == "page 1"
        assert entry2.content == "page 2"

    @pytest.mark.asyncio
    async def test_cache_feed_type(self, cache):
        """Test caching feeds separately from pages."""
        await cache.set_by_url(
            "/feed.xml",
            "<rss>content</rss>",
            content_type="application/rss+xml",
            cache_type="feeds",
        )
        entry = await cache.get_by_url("/feed.xml", cache_type="feeds")
        assert entry is not None
        assert entry.content_type == "application/rss+xml"

    @pytest.mark.asyncio
    async def test_concurrent_access(self, cache):
        """Test concurrent cache operations."""

        async def set_entry(key: str):
            await cache.set(key, f"content_{key}")

        async def get_entry(key: str):
            return await cache.get(key)

        await asyncio.gather(*[set_entry(f"key_{i}") for i in range(10)])
        results = await asyncio.gather(*[get_entry(f"key_{i}") for i in range(10)])
        assert all(r is not None for r in results)
        for i, result in enumerate(results):
            assert result.content == f"content_key_{i}"
