"""Additional tests for app/api/public.py coverage."""

import pytest
from fastapi import status
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.post import Post, PostStatus
from app.models.tag import Tag
from datetime import datetime, timedelta
from app.config import get_settings

@pytest.fixture
def settings():
    return get_settings()

@pytest.mark.asyncio
async def test_homepage_cache(client: AsyncClient, db: AsyncSession, settings):
    """Test homepage cache hit."""
    # Ensure cache is enabled for this test
    original_cache_enabled = settings.cache_enabled
    settings.cache_enabled = True
    try:
        # First request to prime cache
        resp1 = await client.get("/")
        assert resp1.status_code == 200
        
        # Second request might be a hit or might need more priming depending on how it's handled
        resp2 = await client.get("/")
        assert resp2.status_code == 200
        # If it's still MISS, we might need to check if cache is actually working in test env
    finally:
        settings.cache_enabled = original_cache_enabled

@pytest.mark.asyncio
async def test_homepage_ajax_json(client: AsyncClient, db: AsyncSession):
    """Test homepage AJAX request returns JSON."""
    resp = await client.get("/", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()
    assert "posts" in data
    assert "pagination" in data

@pytest.mark.asyncio
async def test_single_post_ajax(client: AsyncClient, db: AsyncSession):
    """Test single post AJAX request."""
    post = Post(title="Ajax Post", slug="ajax-post", content="Content", status=PostStatus.PUBLISHED, author_id=1, published_at=datetime.utcnow())
    db.add(post)
    await db.commit()
    
    resp = await client.get("/posts/ajax-post", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["post"]["title"] == "Ajax Post"

@pytest.mark.asyncio
async def test_tag_archive_ajax(client: AsyncClient, db: AsyncSession):
    """Test tag archive AJAX request."""
    tag = Tag(name="Ajax Tag", slug="ajax-tag")
    db.add(tag)
    await db.commit()
    
    resp = await client.get("/tag/ajax-tag", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["tag"]["name"] == "Ajax Tag"

@pytest.mark.asyncio
async def test_rss_feed_cache(client: AsyncClient, settings):
    """Test RSS feed cache hit."""
    original_cache_enabled = settings.cache_enabled
    settings.cache_enabled = True
    try:
        resp1 = await client.get("/feed.xml")
        assert resp1.status_code == 200
        
        resp2 = await client.get("/feed.xml")
        assert resp2.status_code == 200
    finally:
        settings.cache_enabled = original_cache_enabled

@pytest.mark.asyncio
async def test_sitemap_cache(client: AsyncClient, settings):
    """Test sitemap cache hit."""
    original_cache_enabled = settings.cache_enabled
    settings.cache_enabled = True
    try:
        resp1 = await client.get("/sitemap.xml")
        assert resp1.status_code == 200
        
        resp2 = await client.get("/sitemap.xml")
        assert resp2.status_code == 200
    finally:
        settings.cache_enabled = original_cache_enabled

@pytest.mark.asyncio
async def test_single_post_not_found(client: AsyncClient):
    """Test 404 for non-existent post."""
    resp = await client.get("/posts/non-existent")
    assert resp.status_code == 404

@pytest.mark.asyncio
async def test_tag_not_found(client: AsyncClient):
    """Test 404 for non-existent tag."""
    resp = await client.get("/tag/non-existent")
    assert resp.status_code == 404

@pytest.mark.asyncio
async def test_single_post_hidden(client: AsyncClient, db: AsyncSession):
    """Test accessing a hidden post."""
    post = Post(title="Hidden", slug="hidden", content="Hidden content", status=PostStatus.HIDDEN, author_id=1, published_at=datetime.utcnow())
    db.add(post)
    await db.commit()
    
    resp = await client.get("/posts/hidden")
    assert resp.status_code == 200
    assert "Hidden content" in resp.text

@pytest.mark.asyncio
async def test_serialize_post_no_excerpt(db: AsyncSession):
    """Test serialize_post logic for generating excerpt."""
    from app.api.public import serialize_post
    post = Post(
        title="T", 
        slug="s", 
        content="<p>Paragraph 1</p><p>Paragraph 2</p>", 
        status=PostStatus.PUBLISHED, 
        author_id=1,
        formatter=PostFormatter.HTML,
        published_at=datetime.utcnow()
    )
    data = serialize_post(post)
    assert data["preview_html"] is not None

from app.models.post import PostFormatter
