"""Tests for light interface routes and UI components."""

from unittest.mock import Mock

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostFormatter, PostStatus


class TestLightAuthenticationUI:
    """Test cases for light login/logout UI."""

    @pytest.mark.asyncio
    async def test_login_page_renders(self, client: AsyncClient) -> None:
        """Test login page renders correctly."""
        response = await client.get("/light/login")
        assert response.status_code == 200
        assert "Sign In" in response.text

    @pytest.mark.asyncio
    async def test_login_page_redirects_if_authenticated(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test login page redirects to dashboard if already authenticated."""
        response = await client.get(
            "/light/login",
            cookies=auth_cookies,
            follow_redirects=False,
        )
        assert response.status_code == 303
        assert response.headers["location"] == "/light/"

    @pytest.mark.asyncio
    async def test_logout_clears_session(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test logout redirects and clears session cookie."""
        response = await client.get(
            "/light/logout",
            cookies=auth_cookies,
            follow_redirects=False,
        )
        assert response.status_code == 303
        assert "session_token" in response.headers.get("set-cookie", "").lower()


class TestLightDashboardUI:
    """Test cases for light dashboard interface."""

    @pytest.mark.asyncio
    async def test_dashboard_renders_stats(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test dashboard renders with statistics."""
        response = await client.get("/light/", cookies=auth_cookies)
        assert response.status_code == 200
        assert "Dashboard" in response.text
        assert "Total Posts" in response.text


class TestLightPostsUI:
    """Test cases for post management interface."""

    @pytest.mark.asyncio
    async def test_posts_list_renders(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test posts list page renders."""
        response = await client.get("/light/posts", cookies=auth_cookies)
        assert response.status_code == 200
        assert "Posts" in response.text

    @pytest.mark.asyncio
    async def test_new_post_page_renders(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test new post page renders with form fields."""
        response = await client.get("/light/posts/new", cookies=auth_cookies)
        assert response.status_code == 200
        assert 'name="title"' in response.text

    @pytest.mark.asyncio
    async def test_edit_post_page_renders(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict, test_user: dict
    ) -> None:
        """Test edit post page renders with existing data."""
        user = test_user["user"]
        post = Post(
            title="Edit Me", slug="edit-me", content="C",
            status=PostStatus.DRAFT, author_id=user.id,
            formatter=PostFormatter.MARKDOWN
        )
        db.add(post)
        await db.commit()

        response = await client.get(f"/light/posts/{post.id}", cookies=auth_cookies)
        assert response.status_code == 200
        assert "Edit Me" in response.text


class TestLightContextVariables:
    """Test cases for context variables passed to light templates."""

    @pytest.mark.asyncio
    async def test_get_base_context_public_url(self, db: AsyncSession) -> None:
        """Verify that base context includes correct public_url."""
        from app.api.light import get_base_context
        request = Mock()
        context = await get_base_context(db, request)
        assert "public_url" in context
        assert context["public_url"] == "/"
