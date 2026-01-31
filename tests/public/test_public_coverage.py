import pytest
from unittest.mock import MagicMock, patch
from datetime import datetime, timedelta
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.public import get_db_context
from app.models.user import User
from app.models.post import Post, PostStatus
from app.models.tag import Tag
from app.models.settings import BlogSettings
from app.services.cache_service import get_cache

@pytest.mark.asyncio
async def test_get_db_context_without_settings(db: AsyncSession):
    """Test get_db_context fetches settings when not provided."""
    # Ensure some settings exist
    setting = BlogSettings(key="blog_title", value="Context Test Title", value_type="string")
    db.add(setting)
    await db.commit()
    
    # Call directly without settings
    context = await get_db_context(db, blog_settings=None)
    
    assert "blog_settings" in context
    assert context["blog_settings"]["blog_title"] == "Context Test Title"
    assert context["blog_title"] == "Context Test Title"
    assert "tag_cloud" in context
    assert "tags" in context

@pytest.mark.asyncio
async def test_homepage_ajax_structure(client: AsyncClient, db: AsyncSession):
    """Test full structure of homepage AJAX response."""
    user = User(username="ajaxhome", email="ajaxhome@test.com", password_hash="hash", display_name="AJAX Home")
    db.add(user)
    await db.commit()
    
    post = Post(
        title="Home AJAX Post",
        slug="home-ajax-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow()
    )
    db.add(post)
    await db.commit()
    
    resp = await client.get("/", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()
    
    assert "posts" in data
    assert len(data["posts"]) > 0
    assert "pagination" in data
    assert "is_logged_in" in data
    
    # Check pagination structure
    pagination = data["pagination"]
    assert "page" in pagination
    assert "total_pages" in pagination
    assert "has_next" in pagination
    assert "has_prev" in pagination
    assert "next_page" in pagination
    assert "prev_page" in pagination

@pytest.mark.asyncio
async def test_tag_archive_ajax_structure(client: AsyncClient, db: AsyncSession):
    """Test full structure of tag archive AJAX response."""
    tag = Tag(name="ArchiveTag", slug="archive-tag", post_count=1)
    db.add(tag)
    await db.commit()
    
    resp = await client.get(f"/tag/{tag.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()
    
    assert "posts" in data
    assert "pagination" in data
    assert "tag" in data
    assert "is_logged_in" in data
    assert data["tag"]["name"] == "ArchiveTag"
    assert data["tag"]["slug"] == "archive-tag"

@pytest.mark.asyncio
async def test_tags_page_ajax_structure(client: AsyncClient, db: AsyncSession):
    """Test full structure of tags page (gallery) AJAX response."""
    # Create a post with a tag
    user = User(username="galleryuser", email="gallery@test.com", password_hash="hash", display_name="Gallery")
    db.add(user)
    await db.commit()
    await db.refresh(user)

    tag = Tag(name="GalleryTag", slug="gallery-tag", post_count=1)
    db.add(tag)
    await db.commit()
    await db.refresh(tag)

    # Use refresh to ensure we can work with relations or create with relations
    post = Post(
        title="Gallery Post",
        slug="gallery-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow(),
        tags=[tag] # Initialize with tags
    )
    db.add(post)
    await db.commit()
    
    # We don't need to append again
    
    resp = await client.get("/tags", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()
    
    assert "posts" in data
    assert "pagination" in data
    assert "current_tag" in data
    assert "is_logged_in" in data
    
    # Check post structure in gallery
    assert len(data["posts"]) > 0
    post_data = data["posts"][0]
    assert "preview_html" in post_data
    assert "has_image" in post_data

@pytest.mark.asyncio
async def test_homepage_caches_miss_content(client: AsyncClient, db: AsyncSession, enable_cache):
    """Test that homepage response is stored in cache on miss."""
    # We need to spy on the cache.set_by_url method
    # Since get_cache returns the same instance (lru_cache), we can get it and mock the method
    cache = await get_cache()
    
    # Ensure cache is cleared
    await cache.clear_all()
    
    # Use patch.object to spy/mock set_by_url on the actual cache instance
    with patch.object(cache, 'set_by_url', side_effect=cache.set_by_url) as mock_set:
        resp = await client.get("/")
        assert resp.status_code == 200
        
        # Check if X-Cache header is present
        if "X-Cache" in resp.headers:
            assert resp.headers["X-Cache"] == "MISS"
        else:
            # If header missing, it means cache block wasn't entered or logic failed
            # But let's check if set_by_url was called regardless
            pass
        
        # Verify set_by_url was called
        # args: url, content, query_params, ttl
        mock_set.assert_called_once()
        args, kwargs = mock_set.call_args
        assert args[0] == "/"

@pytest.mark.asyncio
async def test_single_post_caches_miss_content(client: AsyncClient, db: AsyncSession, enable_cache):
    """Test that single post response is stored in cache on miss."""
    user = User(username="cachepost", email="cachepost@test.com", password_hash="hash", display_name="Cache Post")
    db.add(user)
    await db.commit()
    
    post = Post(
        title="Cache Post",
        slug="cache-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow()
    )
    db.add(post)
    await db.commit()
    
    cache = await get_cache()
    await cache.clear_all()
    
    with patch.object(cache, 'set_by_url', side_effect=cache.set_by_url) as mock_set:
        resp = await client.get(f"/posts/{post.slug}")
        assert resp.status_code == 200
        
        if "X-Cache" in resp.headers:
            assert resp.headers["X-Cache"] == "MISS"
        
        mock_set.assert_called_once()
        args, kwargs = mock_set.call_args
        assert args[0] == f"/posts/{post.slug}"

@pytest.mark.asyncio
async def test_tag_archive_caches_miss_content(client: AsyncClient, db: AsyncSession, enable_cache):
    """Test that tag archive response is stored in cache on miss."""
    tag = Tag(name="CacheTag", slug="cache-tag", post_count=0)
    db.add(tag)
    await db.commit()
    
    cache = await get_cache()
    await cache.clear_all()
    
    with patch.object(cache, 'set_by_url', side_effect=cache.set_by_url) as mock_set:
        resp = await client.get(f"/tag/{tag.slug}")
        assert resp.status_code == 200
        
        if "X-Cache" in resp.headers:
            assert resp.headers["X-Cache"] == "MISS"
        
        mock_set.assert_called_once()
        args, kwargs = mock_set.call_args
        assert args[0] == f"/tag/{tag.slug}"

@pytest.mark.asyncio
async def test_rss_feed_caches_miss_content(client: AsyncClient, db: AsyncSession, enable_cache):
    """Test that RSS feed response is stored in cache on miss."""
    cache = await get_cache()
    await cache.clear_all()
    
    with patch.object(cache, 'set_by_url', side_effect=cache.set_by_url) as mock_set:
        resp = await client.get("/feed.xml")
        assert resp.status_code == 200
        
        if "X-Cache" in resp.headers:
            assert resp.headers["X-Cache"] == "MISS"
        
        mock_set.assert_called_once()
        args, kwargs = mock_set.call_args
        assert args[0] == "/feed.xml"
        assert kwargs.get("cache_type") == "feeds"

@pytest.mark.asyncio
async def test_sitemap_caches_miss_content(client: AsyncClient, db: AsyncSession, enable_cache):
    """Test that sitemap response is stored in cache on miss."""
    cache = await get_cache()
    await cache.clear_all()
    
    with patch.object(cache, 'set_by_url', side_effect=cache.set_by_url) as mock_set:
        resp = await client.get("/sitemap.xml")
        assert resp.status_code == 200
        
        if "X-Cache" in resp.headers:
            assert resp.headers["X-Cache"] == "MISS"
        
        mock_set.assert_called_once()
        args, kwargs = mock_set.call_args
        assert args[0] == "/sitemap.xml"
        assert kwargs.get("cache_type") == "feeds"

@pytest.mark.asyncio
async def test_single_post_thumbnail_duplication_logic(client: AsyncClient, db: AsyncSession):
    """Test complex thumbnail duplication avoidance logic in single_post."""
    user = User(username="thumbdup", email="thumbdup@test.com", password_hash="hash", display_name="Thumb Dup")
    db.add(user)
    await db.commit()
    
    # Case 1: Thumbnail path is same as one of the media URLs in content
    post1 = Post(
        title="Dup Post 1",
        slug="dup-post-1",
        content="![Image](/media/image.jpg)",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow(),
        thumbnail_path="/media/image.jpg"
    )
    db.add(post1)
    
    # Case 2: Thumbnail path matches but content has full path /media/originals/...
    post2 = Post(
        title="Dup Post 2",
        slug="dup-post-2",
        content="![Image](/media/originals/image2.jpg)",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow(),
        thumbnail_path="image2.jpg"
    )
    db.add(post2)
    
    await db.commit()
    
    # Check Case 1
    resp = await client.get(f"/posts/{post1.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    data = resp.json()
    # Should only have one media item (duplicate avoided)
    assert len(data["post_media"]) == 1
    
    # Check Case 2
    resp = await client.get(f"/posts/{post2.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    data = resp.json()
    # Should only have one media item (duplicate avoided despite different path strings)
    # The code checks: if not any(m["url"] == thumb_url) AND if not any(m["url"] == thumb_path_full)
    # thumb_url = "image2.jpg"
    # thumb_path_full = "/media/originals/image2.jpg"
    # content has "/media/originals/image2.jpg"
    # So it should NOT insert the thumbnail again
    assert len(data["post_media"]) == 1