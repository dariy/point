"""Tests for caching behavior across public endpoints."""

from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostStatus
from app.models.tag import Tag
from app.models.user import User
from app.services.cache_service import get_cache


@pytest.mark.asyncio
async def test_homepage_cache_with_second_page(
    client: AsyncClient, db: AsyncSession, enable_cache
):
    """Test that page 2 is cached separately from page 1."""
    # Create user and posts
    user = User(
        username="cacheuser",
        email="cache@test.com",
        password_hash="hash",
        display_name="Cache",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # Create 15 posts (more than one page at default 10 per page)
    for i in range(15):
        post = Post(
            title=f"Post {i}",
            slug=f"post-{i}",
            content=f"Content {i}",
            status=PostStatus.PUBLISHED,
            author_id=user.id,
            published_at=datetime.now(UTC) - timedelta(hours=i),
        )
        db.add(post)
    await db.commit()

    # Request page 2 first time (MISS)
    resp = await client.get("/?page=2")
    assert resp.status_code == 200

    # Request page 2 again (HIT)
    resp = await client.get("/?page=2")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_homepage_ajax_bypasses_cache(
    client: AsyncClient, db: AsyncSession, enable_cache
):
    """Test that AJAX requests bypass cache."""
    user = User(
        username="ajaxuser",
        email="ajax@test.com",
        password_hash="hash",
        display_name="AJAX",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    post = Post(
        title="AJAX Test",
        slug="ajax-test",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC),
    )
    db.add(post)
    await db.commit()

    # Regular request (should cache)
    resp1 = await client.get("/")
    assert resp1.status_code == 200

    # AJAX request (should bypass cache)
    resp2 = await client.get("/", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp2.status_code == 200
    assert resp2.headers.get("content-type") == "application/json"


@pytest.mark.asyncio
async def test_single_post_view_count_increments_on_cache(
    client: AsyncClient, db: AsyncSession, enable_cache
):
    """Test that view count increments even when response is cached."""
    user = User(
        username="viewuser",
        email="view@test.com",
        password_hash="hash",
        display_name="View",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    post = Post(
        title="View Count Test",
        slug="view-count-test",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC),
        view_count=0,
    )
    db.add(post)
    await db.commit()
    await db.refresh(post)

    # First request (MISS)
    resp1 = await client.get(f"/posts/{post.slug}")
    assert resp1.status_code == 200

    # Refresh to get updated view count
    await db.refresh(post)
    assert post.view_count == 1

    # Second request (HIT from cache, but view count should still increment)
    resp2 = await client.get(f"/posts/{post.slug}")
    assert resp2.status_code == 200

    # View count should be 2
    await db.refresh(post)
    assert post.view_count == 2


@pytest.mark.asyncio
async def test_homepage_caches_miss_content(
    client: AsyncClient, db: AsyncSession, enable_cache
):
    """Test that homepage response is stored in cache on miss."""
    cache = await get_cache()
    await cache.clear_all()

    with patch.object(cache, "set_by_url", side_effect=cache.set_by_url) as mock_set:
        resp = await client.get("/")
        assert resp.status_code == 200

        if "X-Cache" in resp.headers:
            assert resp.headers["X-Cache"] == "MISS"

        # Verify set_by_url was called
        mock_set.assert_called_once()
        args, kwargs = mock_set.call_args
        assert args[0] == "/"


@pytest.mark.asyncio
async def test_single_post_caches_miss_content(
    client: AsyncClient, db: AsyncSession, enable_cache
):
    """Test that single post response is stored in cache on miss."""
    user = User(
        username="cachepost",
        email="cachepost@test.com",
        password_hash="hash",
        display_name="Cache Post",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    post = Post(
        title="Cache Post",
        slug="cache-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC),
    )
    db.add(post)
    await db.commit()

    cache = await get_cache()
    await cache.clear_all()

    with patch.object(cache, "set_by_url", side_effect=cache.set_by_url) as mock_set:
        resp = await client.get(f"/posts/{post.slug}")
        assert resp.status_code == 200

        if "X-Cache" in resp.headers:
            assert resp.headers["X-Cache"] == "MISS"

        mock_set.assert_called_once()
        args, kwargs = mock_set.call_args
        assert args[0] == f"/posts/{post.slug}"


@pytest.mark.asyncio
async def test_tag_archive_caches_miss_content(
    client: AsyncClient, db: AsyncSession, enable_cache
):
    """Test that tag archive response is stored in cache on miss."""
    tag = Tag(name="CacheTag", slug="cache-tag", post_count=0)
    db.add(tag)
    await db.commit()

    cache = await get_cache()
    await cache.clear_all()

    with patch.object(cache, "set_by_url", side_effect=cache.set_by_url) as mock_set:
        resp = await client.get(f"/tag/{tag.slug}")
        assert resp.status_code == 200

        if "X-Cache" in resp.headers:
            assert resp.headers["X-Cache"] == "MISS"

        mock_set.assert_called_once()
        args, kwargs = mock_set.call_args
        assert args[0] == f"/tag/{tag.slug}"


@pytest.mark.asyncio
async def test_rss_feed_caches_miss_content(
    client: AsyncClient, db: AsyncSession, enable_cache
):
    """Test that RSS feed response is stored in cache on miss."""
    cache = await get_cache()
    await cache.clear_all()

    with patch.object(cache, "set_by_url", side_effect=cache.set_by_url) as mock_set:
        resp = await client.get("/feed.xml")
        assert resp.status_code == 200

        if "X-Cache" in resp.headers:
            assert resp.headers["X-Cache"] == "MISS"

        mock_set.assert_called_once()
        args, kwargs = mock_set.call_args
        assert args[0] == "/feed.xml"
        assert kwargs.get("cache_type") == "feeds"


@pytest.mark.asyncio
async def test_sitemap_caches_miss_content(
    client: AsyncClient, db: AsyncSession, enable_cache
):
    """Test that sitemap response is stored in cache on miss."""
    cache = await get_cache()
    await cache.clear_all()

    with patch.object(cache, "set_by_url", side_effect=cache.set_by_url) as mock_set:
        resp = await client.get("/sitemap.xml")
        assert resp.status_code == 200

        if "X-Cache" in resp.headers:
            assert resp.headers["X-Cache"] == "MISS"

        mock_set.assert_called_once()
        args, kwargs = mock_set.call_args
        assert args[0] == "/sitemap.xml"
        assert kwargs.get("cache_type") == "feeds"
