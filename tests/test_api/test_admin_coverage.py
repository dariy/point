"""Additional tests for app/api/admin.py coverage."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.post import Post, PostStatus
from app.models.tag import Tag
from app.models.user import User
from app.models.media import Media, FileType
from app.models.session import Session
from datetime import datetime, timedelta

@pytest.fixture
async def admin_user(db: AsyncSession):
    user = User(username="admin", email="admin@test.com", password_hash="hash", display_name="Admin")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user

@pytest.fixture
async def auth_cookies(client: AsyncClient, admin_user: User, db: AsyncSession):
    session = Session(
        user_id=admin_user.id,
        token="admin-token",
        expires_at=datetime.utcnow() + timedelta(days=1),
        ip_address="127.0.0.1",
        user_agent="test"
    )
    db.add(session)
    await db.commit()
    return {"session_token": "admin-token"}

from app.dependencies import get_current_user
from app.main import app

@pytest.fixture(autouse=True)
def override_auth(admin_user):
    app.dependency_overrides[get_current_user] = lambda: admin_user
    yield
    app.dependency_overrides.pop(get_current_user, None)

@pytest.mark.asyncio
async def test_admin_dashboard_with_data(client: AsyncClient, admin_user, db: AsyncSession):
    """Test admin dashboard with various data present."""
    # Add a post and media to trigger stats
    post = Post(title="T", slug="s", content="C", status=PostStatus.PUBLISHED, author_id=admin_user.id, view_count=10)
    media = Media(filename="m.jpg", original_path="m.jpg", file_type=FileType.IMAGE, mime_type="i/j", file_size=100, checksum="c")
    db.add_all([post, media])
    await db.commit()
    
    resp = await client.get("/light/")
    assert resp.status_code == 200
    assert "10" in resp.text # view count

@pytest.mark.asyncio
async def test_admin_posts_list_filter(client: AsyncClient, admin_user, db: AsyncSession):
    """Test admin posts list with filter."""
    # Use very specific names to avoid matching sidebar 'Recent Posts' if they appear there
    p1 = Post(title="UniqueDraftTitle", slug="d", content="C", status=PostStatus.DRAFT, author_id=admin_user.id)
    p2 = Post(title="UniquePublishedTitle", slug="p", content="C", status=PostStatus.PUBLISHED, author_id=admin_user.id)
    db.add_all([p1, p2])
    await db.commit()
    
    resp = await client.get("/light/posts?status_filter=draft")
    assert resp.status_code == 200
    # On the posts list page, we expect only the filtered posts in the table.
    # The sidebar doesn't usually show 'Recent Posts' on the posts list page itself in this app.
    assert "UniqueDraftTitle" in resp.text
    assert "UniquePublishedTitle" not in resp.text

@pytest.mark.asyncio
async def test_admin_edit_post_not_found(client: AsyncClient):
    """Test edit post 404."""
    resp = await client.get("/light/posts/999")
    assert resp.status_code == 404

@pytest.mark.asyncio
async def test_admin_tags_page_params(client: AsyncClient, db: AsyncSession):
    """Test tags page with search and sort."""
    t1 = Tag(name="AppleTag", slug="apple")
    t2 = Tag(name="ZebraTag", slug="zebra")
    db.add_all([t1, t2])
    await db.commit()
    
    resp = await client.get("/light/tags?search=Apple&sort_by=name&sort_order=desc")
    assert resp.status_code == 200
    assert "AppleTag" in resp.text
    assert "ZebraTag" not in resp.text

@pytest.mark.asyncio
async def test_admin_media_page_filter(client: AsyncClient, db: AsyncSession):
    """Test media page with file_type filter."""
    m1 = Media(filename="v.mp4", original_path="v.mp4", file_type=FileType.VIDEO, mime_type="v/m", file_size=100, checksum="c1")
    db.add(m1)
    await db.commit()
    
    resp = await client.get("/light/media?file_type=video")
    assert resp.status_code == 200
    assert "v.mp4" in resp.text

@pytest.mark.asyncio
async def test_admin_system_page(client: AsyncClient):
    """Test system page rendering."""
    resp = await client.get("/light/system")
    assert resp.status_code == 200
    assert "System" in resp.text
