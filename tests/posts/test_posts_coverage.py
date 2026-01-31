
import pytest
from datetime import datetime, timedelta
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.post import Post, PostStatus
from app.services.auth_service import AuthService
from app.schemas.auth import UserCreate

@pytest.fixture
async def second_user(db: AsyncSession) -> dict:
    """Create a second test user."""
    auth_service = AuthService(db)
    user_data = UserCreate(
        username="user2",
        email="user2@example.com",
        password="password123",
        display_name="User Two",
    )
    user = await auth_service.create_user(user_data)
    await db.commit()
    return {"username": "user2", "password": "password123", "user": user}

@pytest.fixture
async def second_user_cookies(client: AsyncClient, second_user: dict) -> dict:
    """Login second user."""
    response = await client.post(
        "/api/auth/login",
        json={
            "username": second_user["username"],
            "name": second_user["password"],
        },
    )
    assert response.status_code == 200
    return dict(response.cookies)

@pytest.mark.asyncio
async def test_list_posts_status_filter(client: AsyncClient, db: AsyncSession, auth_cookies: dict, test_user: dict):
    """Test filtering posts by status."""
    user = test_user["user"]
    
    # Create posts with different statuses
    p1 = Post(title="Pub", slug="pub", content="c", status=PostStatus.PUBLISHED, author_id=user.id)
    p2 = Post(title="Draft", slug="draft", content="c", status=PostStatus.DRAFT, author_id=user.id)
    p3 = Post(title="Hidden", slug="hidden", content="c", status=PostStatus.HIDDEN, author_id=user.id)
    db.add_all([p1, p2, p3])
    await db.commit()
    
    # Filter by DRAFT
    resp = await client.get("/api/posts?status=draft", cookies=auth_cookies)
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["posts"]) == 1
    assert data["posts"][0]["slug"] == "draft"

@pytest.mark.asyncio
async def test_get_post_draft_permissions(client: AsyncClient, db: AsyncSession, auth_cookies: dict, second_user_cookies: dict, test_user: dict):
    """Test permissions for viewing draft posts."""
    user = test_user["user"]
    post = Post(title="Draft", slug="draft", content="c", status=PostStatus.DRAFT, author_id=user.id)
    db.add(post)
    await db.commit()
    
    # Owner can view
    resp = await client.get(f"/api/posts/{post.id}", cookies=auth_cookies)
    assert resp.status_code == 200
    
    # Unauthenticated -> 404 (not found, to avoid leaking existence)
    resp = await client.get(f"/api/posts/{post.id}")
    assert resp.status_code == 404
    
    # Other user -> 404
    resp = await client.get(f"/api/posts/{post.id}", cookies=second_user_cookies)
    assert resp.status_code == 404

@pytest.mark.asyncio
async def test_publish_post_permissions(client: AsyncClient, db: AsyncSession, auth_cookies: dict, second_user_cookies: dict, test_user: dict):
    """Test permissions for publishing posts."""
    user = test_user["user"]
    post = Post(title="Draft", slug="draft", content="c", status=PostStatus.DRAFT, author_id=user.id)
    db.add(post)
    await db.commit()
    
    # Other user cannot publish -> 404
    resp = await client.post(f"/api/posts/{post.id}/publish", cookies=second_user_cookies)
    assert resp.status_code == 404
    
    # Post not found -> 404
    resp = await client.post("/api/posts/99999/publish", cookies=auth_cookies)
    assert resp.status_code == 404

@pytest.mark.asyncio
async def test_withdraw_post_permissions(client: AsyncClient, db: AsyncSession, auth_cookies: dict, second_user_cookies: dict, test_user: dict):
    """Test permissions for withdrawing posts."""
    user = test_user["user"]
    post = Post(title="Pub", slug="pub", content="c", status=PostStatus.PUBLISHED, author_id=user.id, published_at=datetime.utcnow())
    db.add(post)
    await db.commit()
    
    # Other user cannot withdraw -> 404
    resp = await client.post(f"/api/posts/{post.id}/withdraw", cookies=second_user_cookies)
    assert resp.status_code == 404
    
    # Post not found -> 404
    resp = await client.post("/api/posts/99999/withdraw", cookies=auth_cookies)
    assert resp.status_code == 404

@pytest.mark.asyncio
async def test_generate_preview_link_permissions(client: AsyncClient, db: AsyncSession, auth_cookies: dict, second_user_cookies: dict, test_user: dict):
    """Test permissions for generating preview links."""
    user = test_user["user"]
    post = Post(title="Draft", slug="draft", content="c", status=PostStatus.DRAFT, author_id=user.id)
    db.add(post)
    await db.commit()
    
    # Other user cannot generate -> 404
    resp = await client.post(f"/api/posts/{post.id}/preview", cookies=second_user_cookies)
    assert resp.status_code == 404
    
    # Post not found -> 404
    resp = await client.post("/api/posts/99999/preview", cookies=auth_cookies)
    assert resp.status_code == 404

@pytest.mark.asyncio
async def test_get_preview_invalid_token(client: AsyncClient, db: AsyncSession, auth_cookies: dict, test_user: dict):
    """Test accessing preview with invalid or expired token."""
    user = test_user["user"]
    post = Post(
        title="Draft", 
        slug="draft", 
        content="c", 
        status=PostStatus.DRAFT, 
        author_id=user.id,
        preview_token="valid_token",
        preview_expires_at=datetime.utcnow() + timedelta(days=1)
    )
    db.add(post)
    await db.commit()
    
    # Valid token via internal API (usually accessed via public route /preview/{token})
    # But /api/posts/{id}/preview is the endpoint checking token
    resp = await client.get(f"/api/posts/{post.id}/preview?token=valid_token", cookies=auth_cookies)
    assert resp.status_code == 200
    
    # Invalid token
    resp = await client.get(f"/api/posts/{post.id}/preview?token=invalid_token", cookies=auth_cookies)
    assert resp.status_code == 404
    
    # Expired token
    post.preview_expires_at = datetime.utcnow() - timedelta(hours=1)
    await db.commit()
    
    resp = await client.get(f"/api/posts/{post.id}/preview?token=valid_token", cookies=auth_cookies)
    assert resp.status_code == 404
