"""Tests for tag management features including CRUD and hierarchy."""

from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.tag import Tag
from app.schemas.tag import TagCreate, TagUpdate
from app.services.tag_service import TagService


@pytest.mark.asyncio
async def test_create_tag_service(db: AsyncSession, service: TagService) -> None:
    """Test creating tags via service layer."""
    p = Tag(name="P", slug="p")
    c = Tag(name="C", slug="c")
    db.add_all([p, c])
    await db.commit()

    # Success with relations
    tag = await service.create_tag(
        TagCreate(name="Both", parent_ids=[p.id], child_ids=[c.id])
    )
    assert len(tag.parents) == 1
    assert len(tag.children) == 1

    # Success without relations
    await service.create_tag(TagCreate(name="None"))

    # Conflict
    with pytest.raises(ValueError, match="already exists"):
        await service.create_tag(TagCreate(name="Both"))


@pytest.mark.asyncio
async def test_tag_retrieval_service(db: AsyncSession, service: TagService) -> None:
    """Test retrieving tags by various fields via service layer."""
    t = Tag(name="Ret", slug="ret")
    db.add(t)
    await db.commit()
    assert (await service.get_tag_by_id(t.id)).id == t.id
    assert (await service.get_tag_by_slug("ret")).id == t.id
    assert (await service.get_tag_by_name("RET")).id == t.id
    assert (await service.get_or_create_tag("Ret")).id == t.id
    assert (await service.get_or_create_tag("New")).name == "New"


@pytest.mark.asyncio
async def test_update_tag_service(db: AsyncSession, service: TagService) -> None:
    """Test updating tags via service layer."""
    t1 = Tag(name="T1", slug="s1")
    t2 = Tag(name="T2", slug="s2")
    db.add_all([t1, t2])
    await db.commit()

    # Not found
    assert await service.update_tag(9999, TagUpdate()) is None

    # Conflicts
    with pytest.raises(ValueError, match="name"):
        await service.update_tag(t1.id, TagUpdate(name="T2"))
    with pytest.raises(ValueError, match="slug"):
        await service.update_tag(t1.id, TagUpdate(slug="s2"))

    # Success paths
    updated = await service.update_tag(t1.id, TagUpdate(name="New", slug=None))
    assert updated.slug == "new"
    updated = await service.update_tag(t1.id, TagUpdate(slug="explicit"))
    assert updated.slug == "explicit"

    # Fields
    fields = [
        "description",
        "custom_url",
        "is_important",
        "is_featured",
        "is_hidden",
        "is_hidden_posts",
        "show_related_tags_as_children",
    ]
    for f in fields:
        await service.update_tag(
            t1.id,
            TagUpdate(**{f: "X" if "url" in f or "desc" in f else True}),
        )

    # Cache fail
    with patch(
        "app.services.tag_service.invalidate_cache_for_tag", side_effect=Exception()
    ):
        await service.update_tag(t1.id, TagUpdate(description="Fail"))


@pytest.mark.asyncio
async def test_delete_tag_service(db: AsyncSession, service: TagService) -> None:
    """Test deleting tags via service layer."""
    assert await service.delete_tag(9999) is False
    t = Tag(name="D", slug="d")
    db.add(t)
    await db.commit()
    with patch(
        "app.services.tag_service.invalidate_cache_for_tag", side_effect=Exception()
    ):
        assert await service.delete_tag(t.id) is True


@pytest.mark.asyncio
async def test_tag_hierarchy_service(db: AsyncSession, service: TagService) -> None:
    """Test tag hierarchy operations via service layer."""
    gp = Tag(name="GP", slug="gp")
    p = Tag(name="P", slug="p")
    c = Tag(name="C", slug="c")
    db.add_all([gp, p, c])
    await db.flush()
    pp = await p.awaitable_attrs.parents
    pp.append(gp)
    cp = await c.awaitable_attrs.parents
    cp.append(p)

    # Root with show_related
    root = Tag(name="R", slug="r", show_related_tags_as_children=True)
    db.add(root)
    await db.commit()

    await service.get_hierarchical_tags()
    await service.get_hierarchical_tags(search="GP")

    # Circular safety
    tc = Tag(name="Circ", slug="circ")
    db.add(tc)
    await db.flush()
    tcp = await tc.awaitable_attrs.parents
    tcp.append(tc)
    await db.commit()
    await service.get_hierarchical_tags()


@pytest.mark.asyncio
async def test_recursive_id_lookups_service(
    db: AsyncSession, service: TagService
) -> None:
    """Test recursive ID lookups via service layer."""
    assert await service.get_descendant_tag_ids(999) == {999}
    assert await service.get_ancestor_tag_ids(999) == {999}

    h = Tag(name="H", slug="h", is_hidden=True)
    hp = Tag(name="HP", slug="hp", is_hidden_posts=True)
    db.add_all([h, hp])
    await db.commit()
    await service.get_publicly_hidden_tag_ids()
    await service.get_hidden_posts_tag_ids()


@pytest.mark.asyncio
async def test_create_tag_api(client: AsyncClient, auth_cookies: dict[str, str]) -> None:
    """Test POST /api/tags"""
    tag_data = {
        "name": "API Tag",
        "slug": "api-tag",
    }
    response = await client.post("/api/tags", json=tag_data, cookies=auth_cookies)
    assert response.status_code == 201

    # Conflict
    response = await client.post("/api/tags", json=tag_data, cookies=auth_cookies)
    assert response.status_code == 409

    # Unauthorized
    client.cookies.clear()
    response = await client.post("/api/tags", json=tag_data)
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_get_tag_api(client: AsyncClient, sample_tag: Tag) -> None:
    """Test GET /api/tags/{tag_id} and GET /api/tags/slug/{slug}"""
    # By ID
    response = await client.get(f"/api/tags/{sample_tag.id}")
    assert response.status_code == 200
    assert response.json()["id"] == sample_tag.id

    # By Slug
    response = await client.get(f"/api/tags/slug/{sample_tag.slug}")
    assert response.status_code == 200
    assert response.json()["slug"] == sample_tag.slug

    # Not found
    response = await client.get("/api/tags/9999")
    assert response.status_code == 404
    response = await client.get("/api/tags/slug/none")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_update_tag_api(
    client: AsyncClient, auth_cookies: dict[str, str], sample_tag: Tag
) -> None:
    """Test PUT /api/tags/{tag_id}"""
    response = await client.put(
        f"/api/tags/{sample_tag.id}", json={"name": "New"}, cookies=auth_cookies
    )
    assert response.status_code == 200

    # Not found
    response = await client.put(
        "/api/tags/9999", json={"name": "New"}, cookies=auth_cookies
    )
    assert response.status_code == 404

    # Conflict
    t2 = {"name": "T2", "slug": "t2"}
    await client.post("/api/tags", json=t2, cookies=auth_cookies)
    response = await client.put(
        f"/api/tags/{sample_tag.id}", json={"slug": "t2"}, cookies=auth_cookies
    )
    assert response.status_code == 409

    # Unauthorized
    client.cookies.clear()
    response = await client.put(f"/api/tags/{sample_tag.id}", json={"name": "X"})
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_delete_tag_api(
    client: AsyncClient, auth_cookies: dict[str, str], sample_tag: Tag
) -> None:
    """Test DELETE /api/tags/{tag_id}"""
    response = await client.delete(f"/api/tags/{sample_tag.id}", cookies=auth_cookies)
    assert response.status_code == 204

    # Not found
    response = await client.delete("/api/tags/9999", cookies=auth_cookies)
    assert response.status_code == 404

    # Unauthorized
    client.cookies.clear()
    response = await client.delete(f"/api/tags/{sample_tag.id}")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_tag_hierarchy_api(
    client: AsyncClient, db: AsyncSession, auth_cookies: dict[str, str]
) -> None:
    """Test tag hierarchy via API."""
    p = Tag(name="P", slug="p")
    c = Tag(name="C", slug="c")
    db.add_all([p, c])
    await db.commit()
    await db.refresh(p)
    await db.refresh(c)

    mid = Tag(name="M", slug="m")
    db.add(mid)
    await db.commit()
    await db.refresh(mid)

    (await mid.awaitable_attrs.parents).append(p)
    (await mid.awaitable_attrs.children).append(c)
    await db.commit()

    response = await client.get(f"/api/tags/{mid.id}")
    assert response.status_code == 200
    data = response.json()
    assert len(data["parents"]) == 1
    assert len(data["children"]) == 1
