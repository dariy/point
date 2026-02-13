"""Tests for post integrations: Quick Post, TagService integration, etc."""

import io
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import AsyncClient
from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post
from app.models.tag import Tag
from app.schemas.post import PostCreate, PostUpdate
from app.services.post_service import PostService
from app.services.tag_service import TagService


def create_test_image(width: int = 10, height: int = 10, format: str = "JPEG") -> bytes:
    """Create a test image in memory."""
    img = Image.new("RGB", (width, height), color="red")
    buffer = io.BytesIO()
    img.save(buffer, format=format)
    buffer.seek(0)
    return buffer.read()


@pytest.mark.asyncio
async def test_quick_post_flow(
    client: AsyncClient, auth_cookies: dict[str, Any]
) -> None:
    """Test the quick post workflow: upload media then link to new post."""
    image_data = create_test_image()

    # 1. Upload media
    files = [("file", ("test-quick.jpg", image_data, "image/jpeg"))]
    response = await client.post(
        "/api/media/upload", files=files, cookies=auth_cookies
    )
    assert response.status_code == 201
    media_id = response.json()["id"]

    # 2. Access new post page with media_id (HTML route)
    response = await client.get(
        f"/light/posts/new?media_id={media_id}", cookies=auth_cookies
    )
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_tag_service_integration_manual(
    db: AsyncSession, service: PostService, test_user: dict[str, Any]
) -> None:
    """Test manual integration with TagService."""
    post = Post(
        title="T", slug="t-manual-int", content="C", author_id=test_user["user"].id
    )
    db.add(post)
    await db.commit()

    mock_ts = MagicMock()
    mock_ts.set_post_tags = AsyncMock(return_value=[Tag(name="Tag1")])

    names = await service.set_post_tags(post, ["Tag1"], mock_ts)
    assert names == ["Tag1"]
    mock_ts.set_post_tags.assert_called_once()


@pytest.mark.asyncio
async def test_create_post_with_tags_integration(
    db: AsyncSession, service: PostService, test_user: dict[str, Any]
) -> None:
    """Test create_post_with_tags full integration."""
    tag_service = TagService(db)
    post = await service.create_post_with_tags(
        PostCreate(title="Tagged Post", content="C", tags=["new-tag"]),
        author_id=test_user["user"].id,
        tag_service=tag_service,
    )
    assert post.id is not None
    assert any(t.name == "new-tag" for t in post.tags)


@pytest.mark.asyncio
async def test_update_post_with_tags_integration(
    db: AsyncSession, service: PostService, test_user: dict[str, Any]
) -> None:
    """Test update_post_with_tags full integration."""
    post = Post(title="T", slug="t-up-tags", content="C", author_id=test_user["user"].id)
    db.add(post)
    await db.commit()

    tag_service = TagService(db)
    updated = await service.update_post_with_tags(
        post.id,
        PostUpdate(tags=["updated-tag"]),
        tag_service=tag_service,
        author_id=test_user["user"].id,
    )
    assert updated is not None
    assert any(t.name == "updated-tag" for t in updated.tags)
