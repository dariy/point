"""Tests for post display: formatting, rendering, thumbnails, and analytics."""

from typing import Any
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.media import Media
from app.models.post import Post, PostFormatter
from app.schemas.post import PostCreate
from app.services.post_service import PostService, _view_counts_buffer


@pytest.mark.asyncio
async def test_get_post_api_success(
    client: AsyncClient, auth_cookies: dict[str, Any], published_post: Post
) -> None:
    """Test getting a published post via API."""
    response = await client.get(f"/api/posts/{published_post.id}")
    assert response.status_code == 200
    data = response.json()
    assert data["title"] == published_post.title
    assert "content_html" in data

    # Not found
    response = await client.get("/api/posts/9999")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_get_post_by_slug_api_success(
    client: AsyncClient,
    published_post: Post,
    sample_post: Post,
    auth_cookies: dict[str, Any]
) -> None:
    """Test getting a post by slug via API."""
    response = await client.get(f"/api/posts/slug/{published_post.slug}")
    assert response.status_code == 200
    assert response.json()["slug"] == published_post.slug

    # Not found
    response = await client.get("/api/posts/slug/non-existent")
    assert response.status_code == 404

    # Draft by slug - authorized (covers 210->213 branch)
    response = await client.get(f"/api/posts/slug/{sample_post.slug}", cookies=auth_cookies)
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_get_post_api_draft_access(
    client: AsyncClient,
    auth_cookies: dict[str, Any],
    sample_post: Post,
    db: AsyncSession,
) -> None:
    """Test access control for draft posts in API."""
    # Unauthorized
    client.cookies.clear()
    response = await client.get(f"/api/posts/{sample_post.id}")
    assert response.status_code == 404

    # Authorized same author
    response = await client.get(f"/api/posts/{sample_post.id}", cookies=auth_cookies)
    assert response.status_code == 200

    # Authorized different author
    from app.schemas.auth import UserCreate
    from app.services.auth_service import AuthService

    auth_service = AuthService(db)
    await auth_service.create_user(
        UserCreate(
            username="other_viewer",
            email="view@example.com",
            password="password123",
            display_name="Other Viewer",
        )
    )
    await db.commit()

    login_response = await client.post(
        "/api/auth/login",
        json={"username": "other_viewer", "name": "password123"},
    )
    other_cookies = dict(login_response.cookies)

    response = await client.get(f"/api/posts/{sample_post.id}", cookies=other_cookies)
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_view_count_increment_flow(
    db: AsyncSession, service: PostService, test_user: dict[str, Any]
) -> None:
    """Test full view count increment and flush flow via service."""
    post = Post(
        title="T", slug="s-analytics", content="C", author_id=test_user["user"].id, view_count=0
    )
    db.add(post)
    await db.commit()

    _view_counts_buffer.clear()
    await service.increment_view_count(post.id)
    await service.increment_view_count(post.id)

    assert _view_counts_buffer[post.id] == 2

    count = await PostService.flush_view_counts(db)
    assert count == 1

    await db.refresh(post)
    assert post.view_count == 2
    assert len(_view_counts_buffer) == 0


@pytest.mark.asyncio
async def test_flush_exception_handling(db: AsyncSession) -> None:
    """Test that view counts are restored to buffer on database failure."""
    _view_counts_buffer.clear()
    _view_counts_buffer[9999] = 10

    with patch.object(db, "execute", side_effect=Exception("DB Error")):
        count = await PostService.flush_view_counts(db)
        assert count == 0
        assert _view_counts_buffer[9999] == 10
    _view_counts_buffer.clear()


@pytest.mark.asyncio
async def test_thumbnail_resolution_service(
    db: AsyncSession, service: PostService
) -> None:
    """Test resolving thumbnail paths from various sources via service."""
    # 1. From Media table
    media = Media(
        filename="img-disp.jpg",
        original_path="originals/img-disp.jpg",
        thumbnail_path="thumb-disp.jpg",
        file_size=1,
        mime_type="image/jpeg",
        file_type="IMAGE",
        checksum="chk-disp",
    )
    db.add(media)
    await db.commit()

    res = await service._resolve_thumbnail_path("/media/originals/img-disp.jpg")
    assert res == "/media/thumb-disp.jpg"

    # 2. Already thumbnail
    assert (
        await service._resolve_thumbnail_path("/media/thumbnails/x.jpg")
        == "/media/thumbnails/x.jpg"
    )

    # 3. None/Other
    assert await service._resolve_thumbnail_path(None) is None
    assert (
        await service._resolve_thumbnail_path("/media/other.jpg")
        == "/media/other.jpg"
    )

    # 4. No split branch
    assert await service._resolve_thumbnail_path("/other/originals/img.jpg") == "/other/originals/img.jpg"


@pytest.mark.asyncio
async def test_auto_excerpt_logic(
    service: PostService, test_user: dict[str, Any]
) -> None:
    """Test excerpt generation logic in service."""
    # Auto-gen from long content
    p1 = await service.create_post(
        PostCreate(title="Auto", content="Content " * 20), test_user["user"].id
    )
    assert p1.excerpt is not None
    assert len(p1.excerpt) > 0

    # Provided excerpt
    p2 = await service.create_post(
        PostCreate(title="Manual", content="C", excerpt="Manual Excerpt"),
        test_user["user"].id,
    )
    assert p2.excerpt == "Manual Excerpt"


@pytest.mark.asyncio
async def test_update_thumbnails_bulk_service(
    db: AsyncSession, service: PostService, test_user: dict[str, Any]
) -> None:
    """Test bulk thumbnail updates via service."""
    p = Post(
        title="P",
        slug="p-thumb",
        content="![](/media/originals/bulk.jpg)",
        author_id=test_user["user"].id,
    )
    db.add(p)
    media = Media(
        filename="bulk.jpg",
        original_path="originals/bulk.jpg",
        thumbnail_path="bulk-t.jpg",
        file_size=1,
        mime_type="image/jpeg",
        file_type="IMAGE",
        checksum="chk-bulk",
    )
    db.add(media)
    await db.commit()

    assert await service.update_all_post_thumbnails() == 1
    assert await service.update_all_post_thumbnails() == 0


def test_content_rendering_html(service: PostService) -> None:
    """Test rendering post content to HTML with different formatters."""
    post = Post(content="**bold**", formatter=PostFormatter.MARKDOWN)
    html = service.render_content(post)
    assert "<strong>bold</strong>" in html
