"""Extended tests for app/api/public.py to increase coverage."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.post import Post, PostStatus
from app.models.tag import Tag
from app.models.user import User
from datetime import datetime


@pytest.mark.asyncio
async def test_homepage_ajax_request(client: AsyncClient, db: AsyncSession):
    """Test homepage with AJAX request returns JSON."""
    user = User(username="ajaxuser", email="ajax@test.com", password_hash="hash", display_name="AJAX User")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    post = Post(
        title="AJAX Test Post",
        slug="ajax-test-post",
        content="AJAX content",
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
    assert "pagination" in data
    assert isinstance(data["posts"], list)


@pytest.mark.asyncio
async def test_homepage_pagination(client: AsyncClient, db: AsyncSession):
    """Test homepage pagination."""
    user = User(username="pageuser", email="page@test.com", password_hash="hash", display_name="Page User")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    # Create multiple posts
    for i in range(15):
        post = Post(
            title=f"Post {i}",
            slug=f"post-{i}",
            content=f"Content {i}",
            status=PostStatus.PUBLISHED,
            author_id=user.id,
            published_at=datetime.utcnow()
        )
        db.add(post)
    await db.commit()
    
    resp = await client.get("/?page=2")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_single_post_ajax(client: AsyncClient, db: AsyncSession):
    """Test single post with AJAX request."""
    user = User(username="postuser", email="post@test.com", password_hash="hash", display_name="Post User")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    post = Post(
        title="AJAX Single Post",
        slug="ajax-single-post",
        content="Content here",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow()
    )
    db.add(post)
    await db.commit()
    
    resp = await client.get(f"/posts/{post.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()
    assert "post" in data
    assert data["post"]["title"] == "AJAX Single Post"


@pytest.mark.asyncio
async def test_single_post_increments_view_count(client: AsyncClient, db: AsyncSession):
    """Test that viewing a post increments view count."""
    user = User(username="viewuser", email="view@test.com", password_hash="hash", display_name="View User")
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
    
    # View the post
    await client.get(f"/posts/{post.slug}")
    
    # Refresh and check
    await db.refresh(post)
    assert post.view_count == 1


@pytest.mark.asyncio
async def test_single_post_not_found(client: AsyncClient):
    """Test single post with non-existent slug."""
    resp = await client.get("/posts/non-existent-slug-12345")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_single_post_draft_not_accessible(client: AsyncClient, db: AsyncSession):
    """Test that draft posts are not accessible publicly."""
    user = User(username="draftuser", email="draft@test.com", password_hash="hash", display_name="Draft User")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    post = Post(
        title="Draft Post",
        slug="draft-post",
        content="Draft content",
        status=PostStatus.DRAFT,
        author_id=user.id
    )
    db.add(post)
    await db.commit()
    
    resp = await client.get(f"/posts/{post.slug}")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_tag_archive(client: AsyncClient, db: AsyncSession):
    """Test tag archive page."""
    user = User(username="taguser", email="tag@test.com", password_hash="hash", display_name="Tag User")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    tag = Tag(name="TestTag", slug="test-tag", post_count=1)
    db.add(tag)
    await db.commit()
    
    post = Post(
        title="Tagged Post",
        slug="tagged-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow()
    )
    post.tags.append(tag)
    db.add(post)
    await db.commit()
    
    resp = await client.get(f"/tag/{tag.slug}")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_tag_archive_ajax(client: AsyncClient, db: AsyncSession):
    """Test tag archive with AJAX request."""
    user = User(username="tagajaxuser", email="tagajax@test.com", password_hash="hash", display_name="Tag AJAX User")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    tag = Tag(name="AjaxTag", slug="ajax-tag", post_count=1)
    db.add(tag)
    await db.commit()
    
    post = Post(
        title="AJAX Tagged Post",
        slug="ajax-tagged-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow()
    )
    post.tags.append(tag)
    db.add(post)
    await db.commit()
    
    resp = await client.get(f"/tag/{tag.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()
    assert "posts" in data
    assert "tag" in data
    assert data["tag"]["slug"] == "ajax-tag"


@pytest.mark.asyncio
async def test_tag_archive_not_found(client: AsyncClient):
    """Test tag archive with non-existent tag."""
    resp = await client.get("/tag/non-existent-tag-12345")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_tags_page(client: AsyncClient, db: AsyncSession):
    """Test tags/gallery page."""
    user = User(username="galleryuser", email="gallery@test.com", password_hash="hash", display_name="Gallery User")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    post = Post(
        title="Gallery Post",
        slug="gallery-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow()
    )
    db.add(post)
    await db.commit()
    
    resp = await client.get("/tags")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_tags_page_with_tag_filter(client: AsyncClient, db: AsyncSession):
    """Test tags page filtered by tag."""
    user = User(username="filteruser", email="filter@test.com", password_hash="hash", display_name="Filter User")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    tag = Tag(name="FilterTag", slug="filter-tag", post_count=1)
    db.add(tag)
    await db.commit()
    
    post = Post(
        title="Filtered Post",
        slug="filtered-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow()
    )
    post.tags.append(tag)
    db.add(post)
    await db.commit()
    
    resp = await client.get(f"/tags/{tag.slug}")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_tags_page_ajax(client: AsyncClient, db: AsyncSession):
    """Test tags page with AJAX request."""
    user = User(username="tagsajax", email="tagsajax@test.com", password_hash="hash", display_name="Tags AJAX")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    post = Post(
        title="Tags AJAX Post",
        slug="tags-ajax-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow()
    )
    db.add(post)
    await db.commit()
    
    resp = await client.get("/tags", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()
    assert "posts" in data
    assert "pagination" in data


@pytest.mark.asyncio
async def test_rss_feed(client: AsyncClient, db: AsyncSession):
    """Test RSS feed generation."""
    user = User(username="rssuser", email="rss@test.com", password_hash="hash", display_name="RSS User")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    post = Post(
        title="RSS Post",
        slug="rss-post",
        content="RSS content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow()
    )
    db.add(post)
    await db.commit()
    
    resp = await client.get("/feed.xml")
    assert resp.status_code == 200
    assert "xml" in resp.headers["content-type"].lower()
    assert "RSS Post" in resp.text or "rss-post" in resp.text


@pytest.mark.asyncio
async def test_sitemap(client: AsyncClient, db: AsyncSession):
    """Test sitemap generation."""
    user = User(username="sitemapuser", email="sitemap@test.com", password_hash="hash", display_name="Sitemap User")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    post = Post(
        title="Sitemap Post",
        slug="sitemap-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow()
    )
    db.add(post)
    await db.commit()
    
    resp = await client.get("/sitemap.xml")
    assert resp.status_code == 200
    assert "xml" in resp.headers["content-type"].lower()
    assert "sitemap-post" in resp.text


@pytest.mark.asyncio
async def test_robots_txt(client: AsyncClient):
    """Test robots.txt generation."""
    resp = await client.get("/robots.txt")
    assert resp.status_code == 200
    assert "User-agent: *" in resp.text
    assert "Disallow: /light/" in resp.text
    assert "Sitemap:" in resp.text


@pytest.mark.asyncio
async def test_single_post_with_thumbnail(client: AsyncClient, db: AsyncSession):
    """Test single post with thumbnail."""
    user = User(username="thumbuser", email="thumb@test.com", password_hash="hash", display_name="Thumb User")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    post = Post(
        title="Thumbnail Post",
        slug="thumbnail-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow(),
        thumbnail_path="/media/test.jpg"
    )
    db.add(post)
    await db.commit()
    
    resp = await client.get(f"/posts/{post.slug}")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_single_post_with_prev_next(client: AsyncClient, db: AsyncSession):
    """Test single post navigation with prev/next posts."""
    user = User(username="navuser", email="nav@test.com", password_hash="hash", display_name="Nav User")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    # Create three posts in sequence
    from datetime import timedelta
    base_time = datetime.utcnow()
    
    post1 = Post(
        title="First Post",
        slug="first-post",
        content="First",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=base_time - timedelta(hours=2)
    )
    post2 = Post(
        title="Second Post",
        slug="second-post",
        content="Second",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=base_time - timedelta(hours=1)
    )
    post3 = Post(
        title="Third Post",
        slug="third-post",
        content="Third",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=base_time
    )
    db.add_all([post1, post2, post3])
    await db.commit()
    
    # View the middle post via AJAX to check navigation
    resp = await client.get(f"/posts/{post2.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()
    # Should have both prev and next
    assert "prev_post" in data or "next_post" in data


@pytest.mark.asyncio
async def test_homepage_with_featured_posts(client: AsyncClient, db: AsyncSession):
    """Test homepage with featured posts."""
    user = User(username="featuser", email="feat@test.com", password_hash="hash", display_name="Feat User")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    post = Post(
        title="Featured Post",
        slug="featured-post",
        content="Featured content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow(),
        is_featured=True
    )
    db.add(post)
    await db.commit()
    
    resp = await client.get("/")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_tag_archive_pagination(client: AsyncClient, db: AsyncSession):
    """Test tag archive with pagination."""
    user = User(username="tagpageuser", email="tagpage@test.com", password_hash="hash", display_name="Tag Page User")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    tag = Tag(name="PageTag", slug="page-tag", post_count=15)
    db.add(tag)
    await db.commit()
    
    # Create multiple posts with this tag
    for i in range(15):
        post = Post(
            title=f"Tag Post {i}",
            slug=f"tag-post-{i}",
            content=f"Content {i}",
            status=PostStatus.PUBLISHED,
            author_id=user.id,
            published_at=datetime.utcnow()
        )
        post.tags.append(tag)
        db.add(post)
    await db.commit()
    
    resp = await client.get(f"/tag/{tag.slug}?page=2")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_single_post_hidden_status(client: AsyncClient, db: AsyncSession):
    """Test accessing a hidden post (should be accessible unlike draft)."""
    user = User(username="hiddenuser", email="hidden@test.com", password_hash="hash", display_name="Hidden User")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    post = Post(
        title="Hidden Post",
        slug="hidden-post",
        content="Hidden content",
        status=PostStatus.HIDDEN,
        author_id=user.id,
        published_at=datetime.utcnow()
    )
    db.add(post)
    await db.commit()
    
    resp = await client.get(f"/posts/{post.slug}")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_serialize_post_with_media(client: AsyncClient, db: AsyncSession):
    """Test post serialization with media content."""
    from app.models.post import PostFormatter
    
    user = User(username="mediauser", email="media@test.com", password_hash="hash", display_name="Media User")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    # Post with image in content
    post = Post(
        title="Media Post",
        slug="media-post",
        content='![Test Image](/media/test.jpg "Test")',
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow(),
        formatter=PostFormatter.MARKDOWN
    )
    db.add(post)
    await db.commit()
    
    resp = await client.get("/", headers={"X-Requested-With": "XMLHttpRequest"})
    assert resp.status_code == 200
    data = resp.json()
    assert "posts" in data
