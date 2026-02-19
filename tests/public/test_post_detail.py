"""Tests for single post detail view functionality."""

from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.media import FileType, Media
from app.models.post import Post, PostFormatter, PostStatus
from app.models.tag import Tag


@pytest.mark.asyncio
async def test_post_page_loads(client: AsyncClient, published_post: Post) -> None:
    """Test that a published post page loads successfully."""
    response = await client.get(f"/posts/{published_post.slug}")
    assert response.status_code == 200
    assert published_post.title in response.text
    assert "text/html" in response.headers["content-type"]


@pytest.mark.asyncio
async def test_post_page_shows_tags(client: AsyncClient, published_post: Post) -> None:
    """Test that post page displays tags."""
    response = await client.get(f"/posts/{published_post.slug}")
    assert response.status_code == 200
    assert "Test Tag" in response.text


@pytest.mark.asyncio
async def test_post_not_found(client: AsyncClient) -> None:
    """Test that non-existent post returns 404."""
    response = await client.get("/posts/non-existent-slug")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_draft_post_not_accessible(client: AsyncClient, draft_post: Post) -> None:
    """Test that draft posts are not publicly accessible."""
    response = await client.get(f"/posts/{draft_post.slug}")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_view_count_increments(
    client: AsyncClient, published_post: Post, db: AsyncSession
) -> None:
    """Test that viewing a post increments view count."""
    initial_count = published_post.view_count
    response = await client.get(f"/posts/{published_post.slug}")
    assert response.status_code == 200
    await db.refresh(published_post)
    assert published_post.view_count == initial_count + 1


@pytest.mark.asyncio
async def test_post_page_loads_with_none_published_at(
    client: AsyncClient, db: AsyncSession, sample_tag: Tag, test_user: dict
) -> None:
    """Test that post page loads even if published_at is None."""
    post = Post(
        title="Test Post No Date",
        slug="test-post-no-date",
        content="Content",
        status=PostStatus.PUBLISHED,
        formatter=PostFormatter.MARKDOWN,
        published_at=None,
        author_id=test_user["user"].id,
    )
    post.tags.append(sample_tag)
    db.add(post)
    await db.commit()
    await db.refresh(post)
    response = await client.get(f"/posts/{post.slug}")
    assert response.status_code == 200
    assert post.title in response.text


@pytest.mark.asyncio
async def test_single_post_ajax(client: AsyncClient, published_post: Post) -> None:
    """Test single post AJAX request returns JSON."""
    response = await client.get(
        f"/posts/{published_post.slug}", headers={"X-Requested-With": "XMLHttpRequest"}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["post"]["title"] == published_post.title


@pytest.mark.asyncio
async def test_single_post_ajax_full(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test single post AJAX response with next/prev and media."""
    user = test_user["user"]
    now = datetime.now(UTC)
    p1 = Post(title="P1", slug="p1", content="c", status=PostStatus.PUBLISHED, published_at=now - timedelta(days=1), formatter=PostFormatter.MARKDOWN, author_id=user.id)
    p2 = Post(title="P2", slug="p2", content="![Img](/a.jpg)", status=PostStatus.PUBLISHED, published_at=now, formatter=PostFormatter.MARKDOWN, author_id=user.id)
    p3 = Post(title="P3", slug="p3", content="c", status=PostStatus.PUBLISHED, published_at=now + timedelta(days=1), formatter=PostFormatter.MARKDOWN, author_id=user.id)
    db.add_all([p1, p2, p3])
    await db.commit()
    response = await client.get(f"/posts/{p2.slug}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert response.status_code == 200
    data = response.json()
    assert data["post"]["slug"] == p2.slug
    assert data["prev_post"]["slug"] == p1.slug
    assert data["next_post"]["slug"] == p3.slug
    assert len(data["post_media"]) > 0


@pytest.mark.asyncio
async def test_single_post_hidden_404(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test that posts with hidden tags return 404 for anonymous users."""
    user = test_user["user"]
    hidden_tag = Tag(name="Hidden Posts", slug="hidden-posts", is_hidden_posts=True)
    db.add(hidden_tag)

    hidden_post = Post(
        title="Hidden Post",
        slug="hidden-post",
        content="Secret content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC)
    )
    hidden_post.tags.append(hidden_tag)
    db.add(hidden_post)
    await db.commit()

    # Anonymous request should 404
    response = await client.get("/posts/hidden-post")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_single_post_status_hidden(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test that hidden posts are 404 for guests but accessible to admin."""
    user = test_user["user"]
    post = Post(
        title="Hidden Status Post",
        slug="hidden-status-post",
        content="Hidden content",
        status=PostStatus.HIDDEN,
        author_id=user.id,
        published_at=datetime.now(UTC)
    )
    db.add(post)
    await db.commit()

    # Guest should get 404
    response = await client.get(f"/posts/{post.slug}")
    assert response.status_code == 404

    # Admin should get 200 (Login first)
    login_resp = await client.post(
        "/api/auth/login",
        json={
            "username": test_user["username"],
            "name": test_user["password"]
        }
    )
    assert login_resp.status_code == 200

    response = await client.get(f"/posts/{post.slug}")
    assert response.status_code == 200
    assert "Hidden content" in response.text

@pytest.mark.asyncio
async def test_single_post_status_page(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test that 'page' status posts are accessible to guests but not in lists."""
    user = test_user["user"]
    post = Post(
        title="Page Status Post",
        slug="page-status-post",
        content="Page content",
        status=PostStatus.PAGE,
        author_id=user.id,
        published_at=datetime.now(UTC)
    )
    db.add(post)
    await db.commit()

    # Guest should get 200 (direct access)
    response = await client.get(f"/posts/{post.slug}")
    assert response.status_code == 200
    assert "Page content" in response.text

    # Should NOT be in homepage list
    response = await client.get("/")
    assert "Page Status Post" not in response.text


@pytest.mark.asyncio
async def test_single_post_media_resolution(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test single_post resolving thumbnail URL to originals via DB hit."""
    user = test_user["user"]
    media = Media(
        filename="test.jpg",
        original_path="originals/test.jpg",
        thumbnail_path="thumbnails/test.jpg",
        file_type=FileType.IMAGE,
        mime_type="image/jpeg",
        file_size=1024,
        checksum="testchecksum"
    )
    db.add(media)

    post = Post(
        title="Post with Media",
        slug="post-media-res",
        content="![](/media/thumbnails/test.jpg)",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC)
    )
    db.add(post)
    await db.commit()

    response = await client.get("/posts/post-media-res")
    assert response.status_code == 200
    assert "/media/originals/test.jpg" in response.text


@pytest.mark.asyncio
async def test_single_post_media_resolution_fallback(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test single_post resolving thumbnail URL to originals without DB record (fallback)."""
    user = test_user["user"]
    post = Post(
        title="Orphaned Thumb",
        slug="orphaned-thumb",
        content="![](/media/thumbnails/2026/02/orphaned.jpg)",
        formatter=PostFormatter.MARKDOWN,
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC)
    )
    db.add(post)
    await db.commit()

    response = await client.get("/posts/orphaned-thumb", headers={"X-Requested-With": "XMLHttpRequest"})
    assert response.status_code == 200
    data = response.json()
    assert data["post_media"][0]["url"] == "/media/originals/2026/02/orphaned.jpg"


@pytest.mark.asyncio
async def test_single_post_with_none_url(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test ensure_original_url with None input."""
    user = test_user["user"]
    post = Post(
        title="None URL Post",
        slug="none-url-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC),
        thumbnail_path=None,
    )
    db.add(post)
    await db.commit()

    response = await client.get(
        "/posts/none-url-post", headers={"X-Requested-With": "XMLHttpRequest"}
    )
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_single_post_prev_next_navigation(client: AsyncClient, db: AsyncSession, test_user: dict, published_post: Post) -> None:
    """Test single post navigation with prev/next posts."""
    user = test_user["user"]
    new_post = Post(
        title="New Post",
        slug="new-post",
        content="Newer",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC)
    )
    db.add(new_post)
    old_post = Post(
        title="Old Post",
        slug="old-post",
        content="Older",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        published_at=datetime.now(UTC) - timedelta(days=2)
    )
    db.add(old_post)
    await db.commit()

    response = await client.get(f"/posts/{published_post.slug}")
    assert response.status_code == 200
    assert "New Post" in response.text
    assert "Old Post" in response.text


@pytest.mark.asyncio
async def test_audio_post_uses_standard_layout(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test that a post with audio but no text uses standard layout (has_text_content=True)."""
    user = test_user["user"]
    post = Post(
        title="Audio Post",
        slug="audio-post",
        content="/2026/02/audio.mp3",  # Simplified audio link
        status=PostStatus.PUBLISHED,
        formatter=PostFormatter.MARKDOWN,
        published_at=datetime.now(UTC),
        author_id=user.id,
    )
    db.add(post)
    await db.commit()

    # Check SSR
    response = await client.get(f"/posts/{post.slug}")
    assert response.status_code == 200
    # Standard layout has 'public-layout post-single-page' class, immersive has 'immersive-layout'
    assert "public-layout post-single-page" in response.text
    assert "immersive-layout" not in response.text

    # Check AJAX
    response = await client.get(
        f"/posts/{post.slug}", headers={"X-Requested-With": "XMLHttpRequest"}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["has_text_content"] is True


@pytest.mark.asyncio
async def test_image_only_post_uses_immersive_layout(client: AsyncClient, db: AsyncSession, test_user: dict) -> None:
    """Test that a post with only an image and no text uses immersive layout."""
    user = test_user["user"]
    post = Post(
        title="Image Post",
        slug="image-post",
        content="![Image](/2026/02/image.jpg)",
        status=PostStatus.PUBLISHED,
        formatter=PostFormatter.MARKDOWN,
        published_at=datetime.now(UTC),
        author_id=user.id,
    )
    db.add(post)
    await db.commit()

    # Check SSR
    response = await client.get(f"/posts/{post.slug}")
    assert response.status_code == 200
    assert "immersive-layout" in response.text
    assert "public-layout post-single-page" not in response.text

    # Check AJAX
    response = await client.get(
        f"/posts/{post.slug}", headers={"X-Requested-With": "XMLHttpRequest"}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["has_text_content"] is False
