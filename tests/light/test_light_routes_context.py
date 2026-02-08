"""Tests for context variables in light interface routes.

Verifies that the correct public_url and other context variables are passed to templates.
"""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from unittest.mock import Mock

from app.models.post import Post, PostStatus, PostFormatter
from app.models.tag import Tag

@pytest.fixture
async def auth_cookies(client: AsyncClient, db: AsyncSession) -> dict:
    """Create a user and return auth cookies."""
    from app.schemas.auth import UserCreate
    from app.services.auth_service import AuthService
    
    auth_service = AuthService(db)
    user_data = UserCreate(
        username="testadmin",
        email="admin@example.com",
        password="password123",
        display_name="Admin"
    )
    await auth_service.create_user(user_data)
    await db.commit()
    
    response = await client.post(
        "/api/auth/login",
        json={"username": "testadmin", "name": "password123"}
    )
    return dict(response.cookies)

@pytest.mark.asyncio
async def test_get_base_context_has_public_url(db: AsyncSession):
    """Verify that get_base_context includes public_url."""
    from app.api.light import get_base_context
    request = Mock()
    context = await get_base_context(db, request)
    assert "public_url" in context
    assert context["public_url"] == "/"

@pytest.mark.asyncio
async def test_dashboard_context_url(client: AsyncClient, auth_cookies: dict):
    """Verify dashboard has default public_url."""
    response = await client.get("/light/", cookies=auth_cookies)
    assert response.status_code == 200
    # The public-home-link in base.html should use public_url
    assert 'class="public-home-link"' in response.text
    assert 'href="/"' in response.text

@pytest.mark.asyncio
async def test_edit_post_context_url(client: AsyncClient, db: AsyncSession, auth_cookies: dict):
    """Verify edit post page has contextual public_url."""
    from app.models.user import User
    from sqlalchemy import select
    
    user = (await db.execute(select(User).where(User.username == "testadmin"))).scalar_one()
    
    post = Post(
        title="Context Test Post",
        slug="context-test-post",
        content="Content",
        status=PostStatus.PUBLISHED,
        author_id=user.id,
        formatter=PostFormatter.MARKDOWN
    )
    db.add(post)
    await db.commit()
    await db.refresh(post)
    
    response = await client.get(f"/light/posts/{post.id}", cookies=auth_cookies)
    assert response.status_code == 200
    assert 'class="public-home-link"' in response.text
    assert 'href="/posts/context-test-post"' in response.text

@pytest.mark.asyncio
async def test_tags_page_context_url(client: AsyncClient, auth_cookies: dict):
    """Verify tags page has contextual public_url."""
    response = await client.get("/light/tags", cookies=auth_cookies)
    assert response.status_code == 200
    assert 'class="public-home-link"' in response.text
    assert 'href="/tags"' in response.text

@pytest.mark.asyncio
async def test_new_post_context_url(client: AsyncClient, auth_cookies: dict):
    """Verify new post page has default public_url."""
    response = await client.get("/light/posts/new", cookies=auth_cookies)
    assert response.status_code == 200
    assert 'class="public-home-link"' in response.text
    assert 'href="/"' in response.text

@pytest.mark.asyncio
async def test_post_edit_no_categories_picker(client: AsyncClient, db: AsyncSession, auth_cookies: dict):
    """Verify that 'Categories (Meta-tags)' section is removed from post edit."""
    from app.models.user import User
    from sqlalchemy import select
    
    user = (await db.execute(select(User).where(User.username == "testadmin"))).scalar_one()
    
    post = Post(
        title="No Categories Test",
        slug="no-categories-test",
        content="Content",
        author_id=user.id,
        formatter=PostFormatter.MARKDOWN
    )
    db.add(post)
    await db.commit()
    
    response = await client.get(f"/light/posts/{post.id}", cookies=auth_cookies)
    assert response.status_code == 200
    assert "Categories (Meta-tags)" not in response.text
    assert "categories-picker" not in response.text
