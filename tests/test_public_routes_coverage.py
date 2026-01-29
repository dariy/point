"Additional coverage tests for public routes."

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from unittest.mock import MagicMock, patch

from app.config import get_settings
from app.models.post import Post, PostStatus, PostFormatter
from app.models.tag import Tag
from app.models.settings import BlogSettings
from app.services.cache_service import get_cache
from app.api import public


@pytest.fixture
async def enable_cache():
    """Enable cache for specific tests."""
    # Get the singleton instance
    settings = get_settings()
    original_value = settings.cache_enabled
    
    # Force enable on the singleton
    settings.cache_enabled = True
    
    # Also force enable on the module-level variable in public router
    # This shouldn't be necessary if lru_cache works as expected, but failsafe
    public.settings.cache_enabled = True
    
    # Ensure cache directory exists
    cache = await get_cache()
    await cache.clear_all()
    
    yield
    
    # Restore
    settings.cache_enabled = original_value
    public.settings.cache_enabled = original_value
    await cache.clear_all()


@pytest.mark.asyncio
async def test_homepage_cache_hit(client: AsyncClient, db: AsyncSession, enable_cache):
    """Test homepage cache hit."""
    # Create a published post to ensure content
    post = Post(
        title="Cache Test Post",
        slug="cache-test",
        content="Test content",
        status=PostStatus.PUBLISHED,
        formatter=PostFormatter.MARKDOWN,
        author_id=1,
    )
    db.add(post)
    await db.commit()
    
    # Verify settings applied
    assert public.settings.cache_enabled is True
    
    # First request to populate cache
    response1 = await client.get("/")
    assert response1.status_code == 200
    assert "X-Cache" in response1.headers, f"Headers: {response1.headers}"
    assert response1.headers["X-Cache"] == "MISS"

    # Second request should hit cache
    response2 = await client.get("/")
    assert response2.status_code == 200
    assert response2.headers["X-Cache"] == "HIT"


@pytest.mark.asyncio
async def test_single_post_cache_hit(client: AsyncClient, db: AsyncSession, enable_cache):
    """Test single post cache hit."""
    post = Post(
        title="Cache Single Post",
        slug="cache-single",
        content="Test content",
        status=PostStatus.PUBLISHED,
        formatter=PostFormatter.MARKDOWN,
        author_id=1,
    )
    db.add(post)
    await db.commit()
    
    # First request
    response1 = await client.get(f"/posts/{post.slug}")
    assert response1.status_code == 200
    assert "X-Cache" in response1.headers, f"Headers: {response1.headers}"
    assert response1.headers["X-Cache"] == "MISS"
    
    # Second request
    response2 = await client.get(f"/posts/{post.slug}")
    assert response2.status_code == 200
    assert response2.headers["X-Cache"] == "HIT"


@pytest.mark.asyncio
async def test_tag_archive_cache_hit(client: AsyncClient, db: AsyncSession, enable_cache):
    """Test tag archive cache hit."""
    tag = Tag(name="CacheTag", slug="cache-tag")
    db.add(tag)
    await db.commit()
    
    # First request
    response1 = await client.get(f"/tag/{tag.slug}")
    assert response1.status_code == 200
    assert response1.headers["X-Cache"] == "MISS"
    
    # Second request
    response2 = await client.get(f"/tag/{tag.slug}")
    assert response2.status_code == 200
    assert response2.headers["X-Cache"] == "HIT"


@pytest.mark.asyncio
async def test_rss_feed_cache_hit(client: AsyncClient, db: AsyncSession, enable_cache):
    """Test RSS feed cache hit."""
    # First request
    response1 = await client.get("/feed.xml")
    assert response1.status_code == 200
    assert response1.headers["X-Cache"] == "MISS"
    
    # Second request
    response2 = await client.get("/feed.xml")
    assert response2.status_code == 200
    assert response2.headers["X-Cache"] == "HIT"


@pytest.mark.asyncio
async def test_sitemap_cache_hit(client: AsyncClient, db: AsyncSession, enable_cache):
    """Test sitemap cache hit."""
    # First request
    response1 = await client.get("/sitemap.xml")
    assert response1.status_code == 200
    assert response1.headers["X-Cache"] == "MISS"
    
    # Second request
    response2 = await client.get("/sitemap.xml")
    assert response2.status_code == 200
    assert response2.headers["X-Cache"] == "HIT"


@pytest.mark.asyncio
async def test_prev_next_post_navigation(client: AsyncClient, db: AsyncSession):
    """Test previous and next post navigation logic."""
    from datetime import datetime, timedelta
    
    now = datetime.utcnow()
    
    # Create 3 posts
    p1 = Post(
        title="Post 1", slug="p1", content="c", 
        status=PostStatus.PUBLISHED, published_at=now - timedelta(days=2),
        formatter=PostFormatter.MARKDOWN, author_id=1
    )
    p2 = Post(
        title="Post 2", slug="p2", content="c", 
        status=PostStatus.PUBLISHED, published_at=now - timedelta(days=1),
        formatter=PostFormatter.MARKDOWN, author_id=1
    )
    p3 = Post(
        title="Post 3", slug="p3", content="c", 
        status=PostStatus.PUBLISHED, published_at=now,
        formatter=PostFormatter.MARKDOWN, author_id=1
    )
    db.add_all([p1, p2, p3])
    await db.commit()
    
    # Request middle post (p2)
    response = await client.get(f"/posts/{p2.slug}")
    assert response.status_code == 200
    content = response.text
    
    # Should have link to p1 (prev) and p3 (next)
    assert p1.slug in content
    assert p3.slug in content


@pytest.mark.asyncio
async def test_post_serialization_with_media_and_excerpt(client: AsyncClient, db: AsyncSession):
    """Test post serialization with media but no explicit excerpt."""
    post = Post(
        title="Media Post",
        slug="media-post",
        content="![Image](/path/to/img.jpg)\n\nSome text content here.",
        status=PostStatus.PUBLISHED,
        formatter=PostFormatter.MARKDOWN,
        author_id=1,
    )
    db.add(post)
    await db.commit()
    
    # Request via AJAX to trigger serialization
    response = await client.get(
        "/", 
        headers={"X-Requested-With": "XMLHttpRequest"}
    )
    assert response.status_code == 200
    data = response.json()
    
    post_data = next(p for p in data["posts"] if p["id"] == post.id)
    assert post_data["has_image"] is True
    # Excerpt should be generated
    assert post_data["excerpt"] is not None


@pytest.mark.asyncio
async def test_tags_page_ajax(client: AsyncClient, db: AsyncSession):
    """Test tags page AJAX request."""
    response = await client.get(
        "/tags", 
        headers={"X-Requested-With": "XMLHttpRequest"}
    )
    assert response.status_code == 200
    data = response.json()
    assert "posts" in data
    assert "tags" not in data # Tags page ajax returns list of posts for the view
    
    # Test filtered by tag
    tag = Tag(name="FilterTag", slug="filter-tag")
    db.add(tag)
    await db.commit()
    
    response = await client.get(
        f"/tags/{tag.slug}", 
        headers={"X-Requested-With": "XMLHttpRequest"}
    )
    assert response.status_code == 200
    data = response.json()
    assert "posts" in data
    assert data["current_tag"] == tag.slug


@pytest.mark.asyncio
async def test_feed_cache_check(client: AsyncClient, enable_cache):
    """Test feed cache check explicitly."""
    # This just ensures we hit the specific feed cache logic
    response = await client.get("/feed.xml")
    assert response.status_code == 200
    assert response.headers["X-Cache"] == "MISS"
    
    response = await client.get("/feed.xml")
    assert response.status_code == 200
    assert response.headers["X-Cache"] == "HIT"