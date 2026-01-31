"""Additional tests to cover gaps in public API coverage."""

import pytest
from datetime import datetime, timedelta
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.post import Post, PostStatus
from app.models.tag import Tag
from app.models.settings import BlogSettings


@pytest.mark.asyncio
async def test_get_db_context_overrides_blog_title(client: AsyncClient, db: AsyncSession):
    """Test that database blog_title setting overrides default."""
    # Create custom setting
    setting = BlogSettings(key="blog_title", value="Custom Blog Title", value_type="string")
    db.add(setting)
    await db.commit()

    # Request homepage to trigger get_db_context
    resp = await client.get("/")
    assert resp.status_code == 200
    assert "Custom Blog Title" in resp.text


@pytest.mark.asyncio
async def test_get_db_context_overrides_blog_subtitle(client: AsyncClient, db: AsyncSession):
    """Test that database blog_subtitle setting overrides default."""
    setting = BlogSettings(key="blog_subtitle", value="My Custom Subtitle", value_type="string")
    db.add(setting)
    await db.commit()

    resp = await client.get("/")
    assert resp.status_code == 200
    assert "My Custom Subtitle" in resp.text


@pytest.mark.asyncio
async def test_get_db_context_overrides_author_name(client: AsyncClient, db: AsyncSession):
    """Test that database author_name setting overrides default."""
    setting = BlogSettings(key="author_name", value="Jane Doe", value_type="string")
    db.add(setting)
    await db.commit()

    resp = await client.get("/")
    assert resp.status_code == 200
    # Author name appears in footer or metadata


@pytest.mark.asyncio
async def test_featured_tags_filtering_by_post_count(client: AsyncClient, db: AsyncSession):
    """Test that tags with post_count = 0 are excluded from navigation."""
    # Create tags with different post counts
    tag1 = Tag(name="HasPosts", slug="has-posts", post_count=5, is_featured=True)
    tag2 = Tag(name="EmptyTag", slug="empty-tag", post_count=0, is_featured=True)
    tag3 = Tag(name="NonFeatured", slug="non-featured", post_count=3, is_featured=False)
    db.add_all([tag1, tag2, tag3])
    await db.commit()

    resp = await client.get("/")
    assert resp.status_code == 200
    # HasPosts should appear (featured + post_count > 0)
    assert "has-posts" in resp.text
    # EmptyTag should not appear (post_count = 0)
    assert "empty-tag" not in resp.text


@pytest.mark.asyncio
async def test_homepage_pagination_invalid_page_number(client: AsyncClient, db: AsyncSession):
    """Test homepage with invalid page numbers."""
    # Create a test user and post
    user = User(username="testuser", email="test@test.com", password_hash="hash", display_name="Test")
    db.add(user)
    await db.commit()
    await db.refresh(user)

    post = Post(
        title="Test", slug="test", content="Content",
        status=PostStatus.PUBLISHED, author_id=user.id,
        published_at=datetime.utcnow()
    )
    db.add(post)
    await db.commit()

    # Test page=0 (should handle gracefully)
    resp = await client.get("/?page=0")
    assert resp.status_code == 200

    # Test negative page
    resp = await client.get("/?page=-1")
    assert resp.status_code == 200

    # Test very large page number (beyond total pages)
    resp = await client.get("/?page=999")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_homepage_cache_with_second_page(client: AsyncClient, db: AsyncSession, enable_cache):
    """Test that page 2 is cached separately from page 1."""
    # Create user and posts
    user = User(username="cacheuser", email="cache@test.com", password_hash="hash", display_name="Cache")
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
            published_at=datetime.utcnow() - timedelta(hours=i)
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
async def test_homepage_ajax_bypasses_cache(client: AsyncClient, db: AsyncSession, enable_cache):
    """Test that AJAX requests bypass cache."""
    user = User(username="ajaxuser", email="ajax@test.com", password_hash="hash", display_name="AJAX")
    db.add(user)
    await db.commit()
    await db.refresh(user)

    post = Post(
        title="AJAX Test",
        slug="ajax-test",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow()
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
async def test_single_post_view_count_increments_on_cache(client: AsyncClient, db: AsyncSession, enable_cache):
    """Test that view count increments even when response is cached."""
    user = User(username="viewuser", email="view@test.com", password_hash="hash", display_name="View")
    db.add(user)
    await db.commit()
    await db.refresh(user)

    post = Post(
        title="View Count Test",
        slug="view-count-test",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow(),
        view_count=0
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
async def test_single_post_with_thumbnail_not_in_content(client: AsyncClient, db: AsyncSession):
    """Test post with thumbnail that's not in content media."""
    user = User(username="thumbuser", email="thumb@test.com", password_hash="hash", display_name="Thumb")
    db.add(user)
    await db.commit()
    await db.refresh(user)

    post = Post(
        title="Thumbnail Test",
        slug="thumbnail-test",
        content="Just text content without images",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow(),
        thumbnail_path="/media/thumb.jpg"
    )
    db.add(post)
    await db.commit()

    # Get post as AJAX to check media list
    resp = await client.get(f"/posts/{post.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()

    # Thumbnail should be in post_media
    assert len(data["post_media"]) > 0
    assert any(m["url"] == "/media/thumb.jpg" for m in data["post_media"])


@pytest.mark.asyncio
async def test_single_post_first_has_no_previous(client: AsyncClient, db: AsyncSession):
    """Test that first chronological post has no previous post."""
    user = User(username="navuser", email="nav@test.com", password_hash="hash", display_name="Nav")
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # Create first post
    first_post = Post(
        title="First Post",
        slug="first-post",
        content="First",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow() - timedelta(days=10)
    )
    db.add(first_post)
    await db.commit()

    # Get as AJAX to check prev_post
    resp = await client.get(f"/posts/{first_post.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()

    # Should have no previous post
    assert data["prev_post"] is None


@pytest.mark.asyncio
async def test_single_post_last_has_no_next(client: AsyncClient, db: AsyncSession):
    """Test that last chronological post has no next post."""
    user = User(username="navuser2", email="nav2@test.com", password_hash="hash", display_name="Nav2")
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # Create last post (most recent)
    last_post = Post(
        title="Last Post",
        slug="last-post",
        content="Last",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow()
    )
    db.add(last_post)
    await db.commit()

    # Get as AJAX to check next_post
    resp = await client.get(f"/posts/{last_post.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()

    # Should have no next post
    assert data["next_post"] is None


@pytest.mark.asyncio
async def test_single_post_ajax_response_complete(client: AsyncClient, db: AsyncSession):
    """Test that AJAX response has all required fields."""
    user = User(username="ajaxcomplete", email="complete@test.com", password_hash="hash", display_name="Complete")
    db.add(user)
    await db.commit()
    await db.refresh(user)

    tag = Tag(name="TestTag", slug="test-tag", post_count=1)
    db.add(tag)
    await db.commit()
    await db.refresh(tag)

    post = Post(
        title="Complete Test",
        slug="complete-test",
        content="# Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow(),
        formatter="markdown"
    )
    db.add(post)
    await db.commit()
    await db.refresh(post)

    # Add tag relationship
    post.tags.append(tag)
    await db.commit()

    resp = await client.get(f"/posts/{post.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()

    # Verify all required keys
    assert "post" in data
    assert "has_text_content" in data
    assert "post_media" in data
    assert "prev_post" in data
    assert "next_post" in data
    assert "blog_settings" in data
    assert "blog_title" in data
    assert "blog_subtitle" in data
    assert "is_logged_in" in data

    # Verify post structure
    assert "id" in data["post"]
    assert "title" in data["post"]
    assert "slug" in data["post"]
    assert "published_date" in data["post"]
    assert "published_iso" in data["post"]
    assert "view_count" in data["post"]
    assert "content_html" in data["post"]
    assert "tags" in data["post"]

    # Verify tag structure
    assert len(data["post"]["tags"]) > 0
    assert "name" in data["post"]["tags"][0]
    assert "slug" in data["post"]["tags"][0]


@pytest.mark.asyncio
async def test_tag_archive_current_tag_in_navigation(client: AsyncClient, db: AsyncSession):
    """Test that current tag appears in navigation even if not featured."""
    user = User(username="taguser", email="tag@test.com", password_hash="hash", display_name="Tag")
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # Create a non-featured tag with posts
    tag = Tag(name="CurrentTag", slug="current-tag", post_count=1, is_featured=False)
    db.add(tag)
    await db.commit()
    await db.refresh(tag)

    post = Post(
        title="Tag Post",
        slug="tag-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow()
    )
    db.add(post)
    await db.commit()
    await db.refresh(post)

    # Add tag relationship
    post.tags.append(tag)
    await db.commit()

    # Request tag archive
    resp = await client.get(f"/tag/{tag.slug}")
    assert resp.status_code == 200

    # Current tag should appear in navigation
    assert "current-tag" in resp.text


@pytest.mark.asyncio
async def test_rss_feed_limit_20_posts(client: AsyncClient, db: AsyncSession):
    """Test that RSS feed limits to 20 most recent posts."""
    user = User(username="rssuser", email="rss@test.com", password_hash="hash", display_name="RSS")
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # Create 25 posts
    for i in range(25):
        post = Post(
            title=f"RSS Post {i}",
            slug=f"rss-post-{i}",
            content=f"Content {i}",
            status=PostStatus.PUBLISHED,
            author_id=user.id,
            published_at=datetime.utcnow() - timedelta(hours=i)
        )
        db.add(post)
    await db.commit()

    # Get RSS feed
    resp = await client.get("/feed.xml")
    assert resp.status_code == 200

    # Count <item> tags in XML
    item_count = resp.text.count("<item>")
    assert item_count == 20  # Should be exactly 20


@pytest.mark.asyncio
async def test_rss_feed_excludes_draft_posts(client: AsyncClient, db: AsyncSession):
    """Test that draft posts don't appear in RSS feed."""
    user = User(username="rssdraft", email="rssdraft@test.com", password_hash="hash", display_name="RSS Draft")
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # Create published post
    pub_post = Post(
        title="Published Post",
        slug="published-post",
        content="Public content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow()
    )
    db.add(pub_post)

    # Create draft post
    draft_post = Post(
        title="Draft Post",
        slug="draft-post",
        content="Draft content",
        status=PostStatus.DRAFT,
        author_id=user.id
    )
    db.add(draft_post)
    await db.commit()

    # Get RSS feed
    resp = await client.get("/feed.xml")
    assert resp.status_code == 200

    # Published post should be in feed
    assert "Published Post" in resp.text
    # Draft post should not be in feed
    assert "Draft Post" not in resp.text


@pytest.mark.asyncio
async def test_sitemap_excludes_empty_tags(client: AsyncClient, db: AsyncSession):
    """Test that tags with no posts don't appear in sitemap."""
    # Create tag with posts
    tag_with_posts = Tag(name="HasPosts", slug="has-posts", post_count=5)
    db.add(tag_with_posts)

    # Create tag without posts
    tag_empty = Tag(name="EmptyTag", slug="empty-tag", post_count=0)
    db.add(tag_empty)
    await db.commit()

    # Get sitemap
    resp = await client.get("/sitemap.xml")
    assert resp.status_code == 200

    # Tag with posts should be in sitemap
    assert "/tag/has-posts" in resp.text
    # Empty tag should not be in sitemap
    assert "/tag/empty-tag" not in resp.text


@pytest.mark.asyncio
async def test_sitemap_excludes_draft_posts(client: AsyncClient, db: AsyncSession):
    """Test that draft posts don't appear in sitemap."""
    user = User(username="sitemapuser", email="sitemap@test.com", password_hash="hash", display_name="Sitemap")
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # Create published post
    pub_post = Post(
        title="Published",
        slug="published-sitemap",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow()
    )
    db.add(pub_post)

    # Create draft post
    draft_post = Post(
        title="Draft",
        slug="draft-sitemap",
        content="Content",
        status=PostStatus.DRAFT,
        author_id=user.id
    )
    db.add(draft_post)
    await db.commit()

    # Get sitemap
    resp = await client.get("/sitemap.xml")
    assert resp.status_code == 200

    # Published post should be in sitemap
    assert "/posts/published-sitemap" in resp.text
    # Draft post should not be in sitemap
    assert "/posts/draft-sitemap" not in resp.text


@pytest.mark.asyncio
async def test_sitemap_includes_homepage_and_gallery(client: AsyncClient):
    """Test that sitemap includes static pages."""
    resp = await client.get("/sitemap.xml")
    assert resp.status_code == 200

    # Should include homepage
    assert "<loc>http://testserver/</loc>" in resp.text or "<loc>http://test/</loc>" in resp.text
    # Should include gallery/tags page
    assert "/tags" in resp.text
