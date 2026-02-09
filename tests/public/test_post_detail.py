"""Tests for single post detail view."""

from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostFormatter, PostStatus
from app.models.tag import Tag
from app.models.user import User


@pytest.mark.asyncio
async def test_single_post_ajax(client: AsyncClient, db: AsyncSession, test_user):
    """Test fetching a single post via AJAX returns JSON."""
    # Create a post
    post = Post(
        title="AJAX Test Post",
        slug="ajax-test-post",
        content="<p>Test Content</p>",
        status=PostStatus.PUBLISHED,
        published_at=datetime.now(UTC),
        formatter=PostFormatter.MARKDOWN,
        author_id=test_user["user"].id,
    )
    db.add(post)
    await db.commit()

    # Request with AJAX header
    response = await client.get(
        f"/posts/{post.slug}", headers={"X-Requested-With": "XMLHttpRequest"}
    )

    assert response.status_code == 200
    assert "application/json" in response.headers["content-type"]

    data = response.json()

    # Verify structure
    assert "post" in data
    assert data["post"]["title"] == "AJAX Test Post"
    assert data["post"]["slug"] == "ajax-test-post"
    assert "content_html" in data["post"]

    assert "has_text_content" in data
    assert data["has_text_content"] is True

    assert "post_media" in data
    assert isinstance(data["post_media"], list)

    assert "blog_settings" in data
    assert "blog_title" in data


@pytest.mark.asyncio
async def test_single_post_immersive_ajax(
    client: AsyncClient, db: AsyncSession, test_user
):
    """Test fetching a media-only post via AJAX returns JSON with correct flags."""
    # Create a post with only image, no text
    post = Post(
        title="Immersive Post",
        slug="immersive-post",
        content="![Image](test.jpg)",
        status=PostStatus.PUBLISHED,
        published_at=datetime.now(UTC),
        formatter=PostFormatter.MARKDOWN,
        author_id=test_user["user"].id,
    )
    db.add(post)
    await db.commit()

    # Request with AJAX header
    response = await client.get(
        f"/posts/{post.slug}", headers={"X-Requested-With": "XMLHttpRequest"}
    )

    assert response.status_code == 200
    data = response.json()

    assert data["post"]["title"] == "Immersive Post"
    assert data["has_text_content"] is False
    assert len(data["post_media"]) > 0


@pytest.mark.asyncio
async def test_single_post_with_thumbnail_not_in_content(
    client: AsyncClient, db: AsyncSession
):
    """Test post with thumbnail that's not in content media."""
    user = User(
        username="thumbuser",
        email="thumb@test.com",
        password_hash="hash",
        display_name="Thumb",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    post = Post(
        title="Thumbnail Test",
        slug="thumbnail-test",
        content="Just text content without images",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC),
        thumbnail_path="/media/thumb.jpg",
    )
    db.add(post)
    await db.commit()

    # Get post as AJAX to check media list
    resp = await client.get(
        f"/posts/{post.slug}", headers={"X-Requested-With": "XMLHttpRequest"}
    )
    assert resp.status_code == 200
    data = resp.json()

    # Thumbnail should be in post_media
    assert len(data["post_media"]) > 0
    assert any(m["url"] == "/media/thumb.jpg" for m in data["post_media"])


@pytest.mark.asyncio
async def test_single_post_ajax_response_complete(
    client: AsyncClient, db: AsyncSession
):
    """Test that AJAX response has all required fields."""
    user = User(
        username="ajaxcomplete",
        email="complete@test.com",
        password_hash="hash",
        display_name="Complete",
    )
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
        published_at=datetime.now(UTC),
        formatter="markdown",
    )
    db.add(post)
    await db.commit()
    await db.refresh(post)

    # Add tag relationship
    post.tags.append(tag)
    await db.commit()

    resp = await client.get(
        f"/posts/{post.slug}", headers={"X-Requested-With": "XMLHttpRequest"}
    )
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
async def test_single_post_thumbnail_duplication_logic(
    client: AsyncClient, db: AsyncSession
):
    """Test complex thumbnail duplication avoidance logic in single_post."""
    user = User(
        username="thumbdup",
        email="thumbdup@test.com",
        password_hash="hash",
        display_name="Thumb Dup",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # Case 1: Thumbnail path is same as one of the media URLs in content
    post1 = Post(
        title="Dup Post 1",
        slug="dup-post-1",
        content="![Image](/media/image.jpg)",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC),
        thumbnail_path="/media/image.jpg",
    )
    db.add(post1)

    # Case 2: Thumbnail path matches but content has full path /media/originals/...
    post2 = Post(
        title="Dup Post 2",
        slug="dup-post-2",
        content="![Image](/media/originals/image2.jpg)",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC),
        thumbnail_path="image2.jpg",
    )
    db.add(post2)

    await db.commit()

    # Check Case 1
    resp = await client.get(
        f"/posts/{post1.slug}", headers={"X-Requested-With": "XMLHttpRequest"}
    )
    data = resp.json()
    # Should only have one media item (duplicate avoided)
    assert len(data["post_media"]) == 1

    # Check Case 2
    resp = await client.get(
        f"/posts/{post2.slug}", headers={"X-Requested-With": "XMLHttpRequest"}
    )
    data = resp.json()
    # Should only have one media item (duplicate avoided despite different path strings)
    assert len(data["post_media"]) == 1
