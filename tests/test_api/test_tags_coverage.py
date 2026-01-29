"""Additional tests for app/api/tags.py coverage."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.tag import Tag
from app.models.user import User
from app.models.session import Session
from app.services.auth_service import hash_token
from datetime import datetime, timedelta

@pytest.fixture
async def tag_admin_headers(client: AsyncClient, db: AsyncSession):
    user = User(username="tagadmin", email="t@test.com", password_hash="hash", display_name="TagAdmin")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    session = Session(
        user_id=user.id, 
        token=hash_token("tag-token"), 
        expires_at=datetime.utcnow() + timedelta(days=1),
        ip_address="127.0.0.1",
        user_agent="test"
    )
    db.add(session)
    await db.commit()
    return {"Cookie": "session_token=tag-token"}

@pytest.mark.asyncio
async def test_list_tags_filtered(client: AsyncClient, db: AsyncSession):
    """Test listing tags with filters."""
    t1 = Tag(name="Alpha", slug="alpha", post_count=10)
    t2 = Tag(name="Beta", slug="beta", post_count=5)
    db.add_all([t1, t2])
    await db.commit()
    
    resp = await client.get("/api/tags?sort_by=post_count&sort_order=desc")
    assert resp.status_code == 200
    data = resp.json()
    assert data[0]["name"] == "Alpha"

@pytest.mark.asyncio
async def test_create_tag_duplicate(client: AsyncClient, tag_admin_headers, db: AsyncSession):
    """Test creating duplicate tag."""
    t = Tag(name="Dup", slug="dup")
    db.add(t)
    await db.commit()
    
    resp = await client.post("/api/tags", json={"name": "Dup"}, headers=tag_admin_headers)
    assert resp.status_code == 409

@pytest.mark.asyncio
async def test_update_tag(client: AsyncClient, tag_admin_headers, db: AsyncSession):
    """Test updating a tag."""
    t = Tag(name="OldName", slug="old-name")
    db.add(t)
    await db.commit()
    
    resp = await client.put(f"/api/tags/{t.id}", json={"name": "NewName"}, headers=tag_admin_headers)
    assert resp.status_code == 200
    assert resp.json()["name"] == "NewName"

@pytest.mark.asyncio
async def test_delete_tag_not_found(client: AsyncClient, tag_admin_headers):
    """Test deleting non-existent tag."""
    resp = await client.delete("/api/tags/999", headers=tag_admin_headers)
    assert resp.status_code == 404
