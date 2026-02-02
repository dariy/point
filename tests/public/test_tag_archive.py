"""Tests for tag archive and tags gallery pages."""

from datetime import datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostFormatter, PostStatus
from app.models.tag import Tag
from app.models.user import User


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

    post = Post(
        title="Gallery Post",
        slug="gallery-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.utcnow(),
        tags=[tag]
    )
    db.add(post)
    await db.commit()

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


@pytest.fixture
async def sample_tag_with_posts(db: AsyncSession, test_user) -> Tag:
    """Create a tag and attach to posts."""
    tag = Tag(name="Ajax Tag", slug="ajax-tag", post_count=0)
    db.add(tag)
    await db.commit()
    await db.refresh(tag)

    for i in range(15):
        post = Post(
            title=f"Tagged Post {i}",
            slug=f"tagged-post-{i}",
            content=f"Content {i}",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            published_at=datetime.utcnow() - timedelta(hours=i),
            author_id=test_user["user"].id,
        )
        post.tags.append(tag)
        db.add(post)

    tag.post_count = 15
    await db.commit()
    return tag


@pytest.mark.asyncio
async def test_tag_archive_ajax_pagination(client: AsyncClient, sample_tag_with_posts: Tag):
    """Test tag archive returns JSON for AJAX requests."""
    response = await client.get(f"/tag/{sample_tag_with_posts.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"

    data = response.json()
    assert "posts" in data
    assert "pagination" in data
    assert "tag" in data
    assert data["tag"]["slug"] == sample_tag_with_posts.slug


@pytest.mark.asyncio
async def test_tag_archive_html_has_ajax_class(client: AsyncClient, sample_tag_with_posts: Tag):
    """Test tag archive HTML pagination links have ajax-link class."""
    response = await client.get(f"/tag/{sample_tag_with_posts.slug}")
    assert response.status_code == 200
    assert "pagination-link" in response.text
    assert "ajax-link" in response.text
