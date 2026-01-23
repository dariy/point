"""Tests for admin interface routes."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService


@pytest.fixture
async def test_user(db: AsyncSession) -> dict:
    """Create a test user and return credentials.

    Returns:
        Dict with username, password, and user object
    """
    auth_service = AuthService(db)
    user_data = UserCreate(
        username="admin",
        email="admin@example.com",
        password="adminpassword123",
        display_name="Admin User",
    )
    user = await auth_service.create_user(user_data)
    await db.commit()

    return {
        "username": "admin",
        "password": "adminpassword123",
        "user": user,
    }


@pytest.fixture
async def auth_cookies(client: AsyncClient, test_user: dict) -> dict:
    """Login and return auth cookies.

    Returns:
        Dict of cookies from login response
    """
    response = await client.post(
        "/api/auth/login",
        json={
            "username": test_user["username"],
            "password": test_user["password"],
        },
    )
    assert response.status_code == 200
    return dict(response.cookies)


class TestLoginPage:
    """Test cases for admin login page."""

    @pytest.mark.asyncio
    async def test_login_page_renders(self, client: AsyncClient) -> None:
        """Test login page renders correctly."""
        response = await client.get("/admin/login")

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "Sign in" in response.text

    @pytest.mark.asyncio
    async def test_login_page_redirects_if_authenticated(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test login page redirects to dashboard if already authenticated."""
        response = await client.get(
            "/admin/login",
            cookies=auth_cookies,
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/admin/"


class TestDashboard:
    """Test cases for admin dashboard."""

    @pytest.mark.asyncio
    async def test_dashboard_requires_auth(self, client: AsyncClient) -> None:
        """Test dashboard redirects to login without authentication."""
        response = await client.get(
            "/admin/",
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/admin/login"

    @pytest.mark.asyncio
    async def test_dashboard_renders_when_authenticated(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test dashboard renders when authenticated."""
        response = await client.get(
            "/admin/",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "Dashboard" in response.text

    @pytest.mark.asyncio
    async def test_dashboard_shows_stats(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test dashboard displays statistics."""
        response = await client.get(
            "/admin/",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        # Check for stat cards
        assert "Total Posts" in response.text
        assert "Published" in response.text
        assert "Drafts" in response.text


class TestPostsList:
    """Test cases for posts list page."""

    @pytest.mark.asyncio
    async def test_posts_list_requires_auth(self, client: AsyncClient) -> None:
        """Test posts list redirects to login without authentication."""
        response = await client.get(
            "/admin/posts",
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/admin/login"

    @pytest.mark.asyncio
    async def test_posts_list_renders_when_authenticated(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test posts list renders when authenticated."""
        response = await client.get(
            "/admin/posts",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "Posts" in response.text

    @pytest.mark.asyncio
    async def test_posts_list_shows_empty_state(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test posts list shows empty state when no posts."""
        response = await client.get(
            "/admin/posts",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert "No posts" in response.text or "Create Post" in response.text


class TestNewPost:
    """Test cases for new post page."""

    @pytest.mark.asyncio
    async def test_new_post_requires_auth(self, client: AsyncClient) -> None:
        """Test new post page redirects to login without authentication."""
        response = await client.get(
            "/admin/posts/new",
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/admin/login"

    @pytest.mark.asyncio
    async def test_new_post_renders_when_authenticated(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test new post page renders when authenticated."""
        response = await client.get(
            "/admin/posts/new",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "New Post" in response.text

    @pytest.mark.asyncio
    async def test_new_post_has_form_fields(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test new post page has required form fields."""
        response = await client.get(
            "/admin/posts/new",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert 'name="title"' in response.text
        assert 'name="content"' in response.text
        assert 'name="status"' in response.text


class TestTagsPage:
    """Test cases for tags management page."""

    @pytest.mark.asyncio
    async def test_tags_page_requires_auth(self, client: AsyncClient) -> None:
        """Test tags page redirects to login without authentication."""
        response = await client.get(
            "/admin/tags",
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/admin/login"

    @pytest.mark.asyncio
    async def test_tags_page_renders_when_authenticated(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test tags page renders when authenticated."""
        response = await client.get(
            "/admin/tags",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "Tags" in response.text


class TestMediaPage:
    """Test cases for media library page."""

    @pytest.mark.asyncio
    async def test_media_page_requires_auth(self, client: AsyncClient) -> None:
        """Test media page redirects to login without authentication."""
        response = await client.get(
            "/admin/media",
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/admin/login"

    @pytest.mark.asyncio
    async def test_media_page_renders_when_authenticated(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test media page renders when authenticated."""
        response = await client.get(
            "/admin/media",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "Media" in response.text

    @pytest.mark.asyncio
    async def test_media_page_shows_empty_state(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test media page shows empty state when no files."""
        response = await client.get(
            "/admin/media",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert "No media" in response.text or "Upload" in response.text


class TestAdminLogout:
    """Test cases for admin logout."""

    @pytest.mark.asyncio
    async def test_logout_redirects_to_login(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test logout redirects to login page."""
        response = await client.get(
            "/admin/logout",
            cookies=auth_cookies,
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/admin/login"

    @pytest.mark.asyncio
    async def test_logout_clears_session_cookie(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test logout clears the session cookie."""
        response = await client.get(
            "/admin/logout",
            cookies=auth_cookies,
            follow_redirects=False,
        )

        # Check that session cookie is deleted
        assert "session_token" in response.headers.get("set-cookie", "").lower()


class TestEditPost:
    """Test cases for edit post page."""

    @pytest.mark.asyncio
    async def test_edit_post_requires_auth(self, client: AsyncClient) -> None:
        """Test edit post page redirects to login without authentication."""
        response = await client.get(
            "/admin/posts/1",
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/admin/login"

    @pytest.mark.asyncio
    async def test_edit_nonexistent_post_returns_404(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test editing non-existent post returns 404."""
        response = await client.get(
            "/admin/posts/99999",
            cookies=auth_cookies,
        )

        assert response.status_code == 404
