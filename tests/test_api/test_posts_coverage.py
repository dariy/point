"""Additional tests for app/api/posts.py coverage."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.post import Post, PostStatus
from app.models.user import User
from app.models.session import Session
from app.services.auth_service import hash_token
from datetime import datetime, timedelta

@pytest.fixture
async def auth_headers(client: AsyncClient, db: AsyncSession):
    user = User(username="poster", email="p@test.com", password_hash="hash", display_name="Poster")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    session = Session(
        user_id=user.id, 
        token=hash_token("post-token"), 
        expires_at=datetime.utcnow() + timedelta(days=1),
        ip_address="127.0.0.1",
        user_agent="test"
    )
    db.add(session)
    await db.commit()
    return {"Cookie": "session_token=post-token"}

@pytest.mark.asyncio
async def test_create_post_validation(client: AsyncClient, auth_headers):
    """Test post creation validation."""
    # Missing title
    resp = await client.post("/api/posts", json={"content": "c"}, headers=auth_headers)
    assert resp.status_code == 422 # Validation error
    
@pytest.mark.asyncio
async def test_create_post_slug_collision(client: AsyncClient, auth_headers, db: AsyncSession):
    """Test slug collision is handled."""
    # Pre-create post with specific slug
    p = Post(title="My Slug", slug="my-slug", content="C", status=PostStatus.DRAFT, author_id=1)
    db.add(p)
    await db.commit()
    
    # Try creating another with same title -> should get unique slug
    data = {"title": "My Slug", "content": "New content", "status": "draft"}
    resp = await client.post("/api/posts", json=data, headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["slug"] != "my-slug"
    assert resp.json()["slug"].startswith("my-slug-")

@pytest.mark.asyncio
async def test_update_post_full(client: AsyncClient, auth_headers, db: AsyncSession):
    """Test updating a post."""
    # Create via DB first to know ID
    # Get user id from headers fixture is tricky, let's query user
    user = await db.scalar(pytest.importorskip("sqlalchemy").select(User).where(User.username == "poster"))
    p = Post(title="Old", slug="old", content="Old", status=PostStatus.DRAFT, author_id=user.id)
    db.add(p)
    await db.commit()
    
    data = {"title": "New Title", "content": "New Content", "status": "published"}
    resp = await client.put(f"/api/posts/{p.id}", json=data, headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["title"] == "New Title"
    assert resp.json()["status"] == "published"

@pytest.mark.asyncio
async def test_delete_post(client: AsyncClient, auth_headers, db: AsyncSession):
    """Test deleting a post."""
    user = await db.scalar(pytest.importorskip("sqlalchemy").select(User).where(User.username == "poster"))
    p = Post(title="Del", slug="del", content="Del", status=PostStatus.DRAFT, author_id=user.id)
    db.add(p)
    await db.commit()
    
    resp = await client.delete(f"/api/posts/{p.id}", headers=auth_headers)
    assert resp.status_code == 200 # or 204
    
    # Verify gone
    resp = await client.get(f"/api/posts/{p.id}", headers=auth_headers)
    assert resp.status_code == 404
