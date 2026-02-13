"""Tests for tag discovery features (clouds, lists, related tags)."""

import pytest
from httpx import AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostStatus
from app.models.tag import Tag
from app.services.tag_service import TagService


@pytest.mark.asyncio
async def test_get_related_tags_service(
    db: AsyncSession, service: TagService, test_user: dict
) -> None:
    """Test getting related tags via service layer."""
    t1 = Tag(name="T1", slug="t1", post_count=1)
    t2 = Tag(name="T2", slug="t2", post_count=1)
    db.add_all([t1, t2])
    await db.flush()
    p = Post(
        title="P",
        slug="p",
        content="C",
        author_id=test_user["user"].id,
        status=PostStatus.PUBLISHED,
    )
    (await p.awaitable_attrs.tags).extend([t1, t2])
    db.add(p)
    await db.commit()
    await service.update_all_post_counts()

    related = await service.get_related_tags(t1.id)
    assert len(related) == 1


@pytest.mark.asyncio
async def test_tag_cloud_service(db: AsyncSession, service: TagService) -> None:
    """Test tag cloud generation via service layer."""
    await db.execute(delete(Tag))
    await db.commit()
    assert await service.get_tag_cloud() == []

    t = Tag(name="T", slug="t", post_count=10, is_featured=True)
    db.add(t)
    await db.commit()
    res = await service.get_tag_cloud()
    assert len(res) == 1


@pytest.mark.asyncio
async def test_special_lists_service(db: AsyncSession, service: TagService) -> None:
    """Test important and featured tag lists via service layer."""
    h = Tag(
        name="H",
        slug="h",
        is_important=True,
        is_featured=True,
        is_hidden=True,
        post_count=1,
    )
    db.add(h)
    await db.commit()

    assert h.id not in [t.id for t in await service.get_important_tags()]
    assert h.id not in [t.id for t in await service.get_featured_tags()]


@pytest.mark.asyncio
async def test_list_tags_service(db: AsyncSession, service: TagService) -> None:
    """Test list_tags with various filters via service layer."""
    h = Tag(name="H", slug="h", is_hidden=True, post_count=1)
    db.add(h)
    await db.flush()
    c = Tag(name="C", slug="c", post_count=1)
    db.add(c)
    await db.flush()
    (await c.awaitable_attrs.parents).append(h)

    i = Tag(name="Imp", slug="i", is_important=True, post_count=2)
    e = Tag(name="E", slug="e", post_count=0)
    db.add_all([i, e])
    await db.commit()

    await service.list_tags(public_only=True)
    await service.list_tags(include_empty=False)
    await service.list_tags(important_only=True)
    await service.list_tags(search="H")
    await service.list_tags(parent_id=h.id)
    await service.list_tags(sort_by="post_count", sort_order="desc")


@pytest.mark.asyncio
async def test_list_tags_api(client: AsyncClient, sample_tag: Tag) -> None:
    """Test GET /api/tags"""
    response = await client.get("/api/tags")
    assert response.status_code == 200
    data = response.json()
    assert data["total"] >= 1

    # Filters
    response = await client.get("/api/tags", params={"important_only": True})
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_tag_cloud_api(client: AsyncClient, sample_tag: Tag) -> None:
    """Test GET /api/tags/cloud"""
    response = await client.get("/api/tags/cloud")
    assert response.status_code == 200
    assert "tags" in response.json()
