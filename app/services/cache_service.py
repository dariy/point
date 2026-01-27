"""File-based caching service for rendered pages and feeds.

Provides a file-based cache implementation that stores rendered HTML
and XML content on disk for improved performance.
"""

import asyncio
import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

import aiofiles
import aiofiles.os


class CacheEntry:
    """Represents a cached entry with metadata."""

    def __init__(
        self,
        content: str,
        created_at: float,
        expires_at: float,
        content_type: str = "text/html",
    ):
        """Initialize cache entry.

        Args:
            content: The cached content
            created_at: Timestamp when the entry was created
            expires_at: Timestamp when the entry expires
            content_type: MIME type of the content
        """
        self.content = content
        self.created_at = created_at
        self.expires_at = expires_at
        self.content_type = content_type

    def is_expired(self) -> bool:
        """Check if the entry has expired."""
        return time.time() > self.expires_at

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "content": self.content,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "content_type": self.content_type,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CacheEntry":
        """Create from dictionary."""
        return cls(
            content=data["content"],
            created_at=data["created_at"],
            expires_at=data["expires_at"],
            content_type=data.get("content_type", "text/html"),
        )


class FileCache:
    """File-based cache implementation.

    Stores cached content in the filesystem with JSON metadata
    for TTL management and cache statistics.
    """

    def __init__(self, cache_dir: str | Path):
        """Initialize file cache.

        Args:
            cache_dir: Base directory for cache storage
        """
        self.cache_dir = Path(cache_dir)
        self.pages_dir = self.cache_dir / "pages"
        self.feeds_dir = self.cache_dir / "feeds"
        self._lock = asyncio.Lock()
        self._stats = {
            "hits": 0,
            "misses": 0,
            "sets": 0,
            "deletes": 0,
        }

    async def initialize(self) -> None:
        """Initialize cache directories."""
        await aiofiles.os.makedirs(self.pages_dir, exist_ok=True)
        await aiofiles.os.makedirs(self.feeds_dir, exist_ok=True)

    def _generate_key(self, url: str, query_params: dict | None = None) -> str:
        """Generate cache key from URL and query parameters.

        Args:
            url: The request URL path
            query_params: Optional query parameters

        Returns:
            Hashed cache key
        """
        key_parts = [url]
        if query_params:
            sorted_params = sorted(query_params.items())
            key_parts.append(str(sorted_params))
        key_string = "|".join(key_parts)
        return hashlib.sha256(key_string.encode()).hexdigest()[:32]

    def _get_cache_path(self, key: str, cache_type: str = "pages") -> Path:
        """Get file path for cache key.

        Args:
            key: The cache key
            cache_type: Type of cache (pages or feeds)

        Returns:
            Path to the cache file
        """
        base_dir = self.pages_dir if cache_type == "pages" else self.feeds_dir
        return base_dir / f"{key}.json"

    async def get(self, key: str, cache_type: str = "pages") -> CacheEntry | None:
        """Retrieve cached value.

        Args:
            key: The cache key
            cache_type: Type of cache (pages or feeds)

        Returns:
            CacheEntry if found and not expired, None otherwise
        """
        cache_path = self._get_cache_path(key, cache_type)

        try:
            if not await aiofiles.os.path.exists(cache_path):
                self._stats["misses"] += 1
                return None

            async with aiofiles.open(cache_path, encoding="utf-8") as f:
                data = json.loads(await f.read())

            entry = CacheEntry.from_dict(data)

            if entry.is_expired():
                await self.delete(key, cache_type)
                self._stats["misses"] += 1
                return None

            self._stats["hits"] += 1
            return entry

        except (json.JSONDecodeError, OSError, KeyError):
            self._stats["misses"] += 1
            return None

    async def get_by_url(
        self,
        url: str,
        query_params: dict | None = None,
        cache_type: str = "pages",
    ) -> CacheEntry | None:
        """Retrieve cached value by URL.

        Args:
            url: The request URL path
            query_params: Optional query parameters
            cache_type: Type of cache (pages or feeds)

        Returns:
            CacheEntry if found and not expired, None otherwise
        """
        key = self._generate_key(url, query_params)
        return await self.get(key, cache_type)

    async def set(
        self,
        key: str,
        content: str,
        ttl: int = 3600,
        content_type: str = "text/html",
        cache_type: str = "pages",
    ) -> None:
        """Store value in cache.

        Args:
            key: The cache key
            content: Content to cache
            ttl: Time to live in seconds (default 1 hour)
            content_type: MIME type of the content
            cache_type: Type of cache (pages or feeds)
        """
        cache_path = self._get_cache_path(key, cache_type)
        now = time.time()

        entry = CacheEntry(
            content=content,
            created_at=now,
            expires_at=now + ttl,
            content_type=content_type,
        )

        async with self._lock:
            async with aiofiles.open(cache_path, "w", encoding="utf-8") as f:
                await f.write(json.dumps(entry.to_dict()))

        self._stats["sets"] += 1

    async def set_by_url(
        self,
        url: str,
        content: str,
        query_params: dict | None = None,
        ttl: int = 3600,
        content_type: str = "text/html",
        cache_type: str = "pages",
    ) -> str:
        """Store value in cache by URL.

        Args:
            url: The request URL path
            content: Content to cache
            query_params: Optional query parameters
            ttl: Time to live in seconds (default 1 hour)
            content_type: MIME type of the content
            cache_type: Type of cache (pages or feeds)

        Returns:
            The generated cache key
        """
        key = self._generate_key(url, query_params)
        await self.set(key, content, ttl, content_type, cache_type)
        return key

    async def delete(self, key: str, cache_type: str = "pages") -> bool:
        """Remove specific key from cache.

        Args:
            key: The cache key
            cache_type: Type of cache (pages or feeds)

        Returns:
            True if deleted, False if not found
        """
        cache_path = self._get_cache_path(key, cache_type)

        try:
            if await aiofiles.os.path.exists(cache_path):
                await aiofiles.os.remove(cache_path)
                self._stats["deletes"] += 1
                return True
            return False
        except OSError:
            return False

    async def delete_by_url(
        self,
        url: str,
        query_params: dict | None = None,
        cache_type: str = "pages",
    ) -> bool:
        """Remove cached value by URL.

        Args:
            url: The request URL path
            query_params: Optional query parameters
            cache_type: Type of cache (pages or feeds)

        Returns:
            True if deleted, False if not found
        """
        key = self._generate_key(url, query_params)
        return await self.delete(key, cache_type)

    async def clear_all(self) -> int:
        """Clear entire cache.

        Returns:
            Number of entries cleared
        """
        count = 0

        for cache_dir in [self.pages_dir, self.feeds_dir]:
            if not await aiofiles.os.path.exists(cache_dir):
                continue

            for filename in os.listdir(cache_dir):
                if filename.endswith(".json"):
                    try:
                        await aiofiles.os.remove(cache_dir / filename)
                        count += 1
                    except OSError:
                        pass

        return count

    async def clear_pattern(self, pattern: str) -> int:
        """Clear cache entries matching pattern.

        Supported patterns:
        - 'pages:*' - All page cache
        - 'feeds:*' - All feed cache
        - 'homepage' - Homepage entries (URL starts with /)
        - 'posts:*' - All post pages
        - 'tags:*' - All tag pages

        Args:
            pattern: Pattern to match

        Returns:
            Number of entries cleared
        """
        count = 0

        if pattern == "pages:*":
            if await aiofiles.os.path.exists(self.pages_dir):
                for filename in os.listdir(self.pages_dir):
                    if filename.endswith(".json"):
                        try:
                            await aiofiles.os.remove(self.pages_dir / filename)
                            count += 1
                        except OSError:
                            pass

        elif pattern == "feeds:*":
            if await aiofiles.os.path.exists(self.feeds_dir):
                for filename in os.listdir(self.feeds_dir):
                    if filename.endswith(".json"):
                        try:
                            await aiofiles.os.remove(self.feeds_dir / filename)
                            count += 1
                        except OSError:
                            pass

        else:
            # Clear all caches for content-related patterns
            # These patterns clear everything since we can't track URL mappings
            return await self.clear_all()

        return count

    async def clear_for_post_change(self) -> int:
        """Clear caches affected by post changes.

        Clears homepage, tag pages, feeds, etc.

        Returns:
            Number of entries cleared
        """
        return await self.clear_all()

    async def clear_for_tag_change(self) -> int:
        """Clear caches affected by tag changes.

        Returns:
            Number of entries cleared
        """
        return await self.clear_all()

    async def cleanup_expired(self) -> int:
        """Remove expired entries from cache.

        Returns:
            Number of expired entries removed
        """
        count = 0
        now = time.time()

        for cache_dir in [self.pages_dir, self.feeds_dir]:
            if not await aiofiles.os.path.exists(cache_dir):
                continue

            for filename in os.listdir(cache_dir):
                if not filename.endswith(".json"):
                    continue

                cache_path = cache_dir / filename
                try:
                    async with aiofiles.open(cache_path, encoding="utf-8") as f:
                        data = json.loads(await f.read())

                    if data.get("expires_at", 0) < now:
                        await aiofiles.os.remove(cache_path)
                        count += 1

                except (json.JSONDecodeError, OSError, KeyError):
                    # Remove corrupted files
                    try:
                        await aiofiles.os.remove(cache_path)
                        count += 1
                    except OSError:
                        pass

        return count

    async def get_stats(self) -> dict[str, Any]:
        """Get cache statistics.

        Returns:
            Dictionary with cache statistics
        """
        pages_count = 0
        pages_size = 0
        feeds_count = 0
        feeds_size = 0

        if await aiofiles.os.path.exists(self.pages_dir):
            for filename in os.listdir(self.pages_dir):
                if filename.endswith(".json"):
                    pages_count += 1
                    try:
                        stat = await aiofiles.os.stat(self.pages_dir / filename)
                        pages_size += stat.st_size
                    except OSError:
                        pass

        if await aiofiles.os.path.exists(self.feeds_dir):
            for filename in os.listdir(self.feeds_dir):
                if filename.endswith(".json"):
                    feeds_count += 1
                    try:
                        stat = await aiofiles.os.stat(self.feeds_dir / filename)
                        feeds_size += stat.st_size
                    except OSError:
                        pass

        total_requests = self._stats["hits"] + self._stats["misses"]
        hit_rate = (
            (self._stats["hits"] / total_requests * 100) if total_requests > 0 else 0
        )

        return {
            "pages": {
                "count": pages_count,
                "size_bytes": pages_size,
            },
            "feeds": {
                "count": feeds_count,
                "size_bytes": feeds_size,
            },
            "total_entries": pages_count + feeds_count,
            "total_size_bytes": pages_size + feeds_size,
            "hits": self._stats["hits"],
            "misses": self._stats["misses"],
            "sets": self._stats["sets"],
            "deletes": self._stats["deletes"],
            "hit_rate_percent": round(hit_rate, 2),
        }


# Global cache instance
_cache: FileCache | None = None


async def get_cache() -> FileCache:
    """Get or create the global cache instance.

    Returns:
        FileCache instance
    """
    global _cache
    if _cache is None:
        from app.config import get_settings

        settings = get_settings()
        cache_dir = Path(settings.storage_path) / "cache"
        _cache = FileCache(cache_dir)
        await _cache.initialize()
    return _cache


async def invalidate_cache_for_post() -> int:
    """Invalidate cache after post changes.

    Returns:
        Number of cache entries cleared
    """
    cache = await get_cache()
    return await cache.clear_for_post_change()


async def invalidate_cache_for_tag() -> int:
    """Invalidate cache after tag changes.

    Returns:
        Number of cache entries cleared
    """
    cache = await get_cache()
    return await cache.clear_for_tag_change()
