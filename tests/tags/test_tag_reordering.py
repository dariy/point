"""Tests for tag reordering functionality.

Tests the reorder_tag method in TagService and the reorder API endpoint.
"""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.tag import TagCreate
from app.services.tag_service import TagService


@pytest.mark.asyncio
async def test_reorder_inside_tag(db: AsyncSession):
    """Test moving a tag inside another tag."""
    service = TagService(db)

    # Create tags
    t1 = await service.create_tag(TagCreate(name="Parent"))
    t2 = await service.create_tag(TagCreate(name="Child"))

    # Verify t2 is initially child of "other" (default)
    other = await service.get_tag_by_name("other")
    assert other in t2.parents

    # Reorder t2 inside t1
    await service.reorder_tag(tag_id=t2.id, target_id=t1.id, position="inside")
    await db.commit()

    # Refresh and check
    await db.refresh(t2, attribute_names=["parents"])
    assert t1 in t2.parents
    assert other not in t2.parents


@pytest.mark.asyncio
async def test_reorder_before_tag(db: AsyncSession):
    """Test reordering a tag before another tag."""
    service = TagService(db)

    # Create a parent and three children
    p = await service.create_tag(TagCreate(name="Container"))
    c1 = await service.create_tag(TagCreate(name="A", sort_order=10, parent_ids=[p.id]))
    c2 = await service.create_tag(TagCreate(name="B", sort_order=20, parent_ids=[p.id]))
    c3 = await service.create_tag(TagCreate(name="C", sort_order=30, parent_ids=[p.id]))

    await db.commit()

    # Move c3 before c1
    await service.reorder_tag(tag_id=c3.id, target_id=c1.id, position="before", current_parent_id=p.id)
    await db.commit()

    # Refresh all
    await db.refresh(c1)
    await db.refresh(c2)
    await db.refresh(c3)

    # Check sort orders (they should be 10, 20, 30, 40...)
    # In my implementation, c3 should be index 0, c1 index 1, c2 index 2
    assert c3.sort_order == 10
    assert c1.sort_order == 20
    assert c2.sort_order == 30


@pytest.mark.asyncio
async def test_reorder_after_tag(db: AsyncSession):
    """Test reordering a tag after another tag."""
    service = TagService(db)

    # Create a parent and three children
    p = await service.create_tag(TagCreate(name="Container2"))
    c1 = await service.create_tag(TagCreate(name="X", sort_order=10, parent_ids=[p.id]))
    c2 = await service.create_tag(TagCreate(name="Y", sort_order=20, parent_ids=[p.id]))
    c3 = await service.create_tag(TagCreate(name="Z", sort_order=30, parent_ids=[p.id]))

    await db.commit()

    # Move c1 after c2
    await service.reorder_tag(tag_id=c1.id, target_id=c2.id, position="after", current_parent_id=p.id)
    await db.commit()

    # Refresh all
    await db.refresh(c1)
    await db.refresh(c2)
    await db.refresh(c3)

    # Expected order: c2, c1, c3
    assert c2.sort_order == 10
    assert c1.sort_order == 20
    assert c3.sort_order == 30


@pytest.mark.asyncio
async def test_reorder_api(client: AsyncClient, auth_cookies: dict):
    """Test reordering tags via API."""

    # Create tags via API
    resp1 = await client.post("/api/tags", json={"name": "ApiParent"}, cookies=auth_cookies)
    assert resp1.status_code == 201
    t1_id = resp1.json()["id"]

    resp2 = await client.post("/api/tags", json={"name": "ApiChild1", "parent_ids": [t1_id]}, cookies=auth_cookies)
    assert resp2.status_code == 201
    t2_id = resp2.json()["id"]

    resp3 = await client.post("/api/tags", json={"name": "ApiChild2", "parent_ids": [t1_id]}, cookies=auth_cookies)
    assert resp3.status_code == 201
    t3_id = resp3.json()["id"]

    # Reorder ApiChild2 before ApiChild1
    reorder_resp = await client.post(
        f"/api/tags/{t3_id}/reorder",
        json={"target_id": t2_id, "position": "before", "current_parent_id": t1_id},
        cookies=auth_cookies
    )

    assert reorder_resp.status_code == 200

    # Verify via retrieval
    t2_resp = await client.get(f"/api/tags/{t2_id}")
    t3_resp = await client.get(f"/api/tags/{t3_id}")

    # My service assigns 10, 20...
    assert t3_resp.json()["sort_order"] < t2_resp.json()["sort_order"]
