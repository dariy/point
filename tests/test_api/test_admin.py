"""Tests for light interface routes."""

import pytest
from datetime import datetime
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostStatus, PostFormatter
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
        username="light",
        email="light@example.com",
        password="lightpassword123",
        display_name="Light User",
    )
    user = await auth_service.create_user(user_data)
    await db.commit()

    return {
        "username": "light",
        "password": "lightpassword123",
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
            "name": test_user["password"],  # API expects 'name' field for password
        },
    )
    assert response.status_code == 200
    return dict(response.cookies)


class TestLoginPage:
    """Test cases for light login page."""

    @pytest.mark.asyncio
    async def test_login_page_renders(self, client: AsyncClient) -> None:
        """Test login page renders correctly."""
        response = await client.get("/light/login")

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
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


class TestDashboard:
    """Test cases for light dashboard."""

    @pytest.mark.asyncio
    async def test_dashboard_requires_auth(self, client: AsyncClient) -> None:
        """Test dashboard redirects to login without authentication."""
        response = await client.get(
            "/light/",
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/light/login"

    @pytest.mark.asyncio
    async def test_dashboard_renders_when_authenticated(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test dashboard renders when authenticated."""
        response = await client.get(
            "/light/",
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
            "/light/",
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
            "/light/posts",
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/light/login"

    @pytest.mark.asyncio
    async def test_posts_list_renders_when_authenticated(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test posts list renders when authenticated."""
        response = await client.get(
            "/light/posts",
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
            "/light/posts",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert "No posts" in response.text or "Create Post" in response.text

    @pytest.mark.asyncio
    async def test_posts_list_view_link_correct(
        self, client: AsyncClient, auth_cookies: dict, db: AsyncSession, test_user: dict
    ) -> None:
        """Test posts list shows correct view link for published posts."""
        # Create a published post
        post = Post(
            title="Test Post Link",
            slug="test-post-link",
            content="Content",
            status=PostStatus.PUBLISHED,
            author_id=test_user["user"].id,
            published_at=datetime.utcnow(),
            formatter=PostFormatter.MARKDOWN
        )
        db.add(post)
        await db.commit()

        response = await client.get(
            "/light/posts",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        # Check for the correct link
        assert f'href="/posts/{post.slug}"' in response.text


class TestNewPost:
    """Test cases for new post page."""

    @pytest.mark.asyncio
    async def test_new_post_requires_auth(self, client: AsyncClient) -> None:
        """Test new post page redirects to login without authentication."""
        response = await client.get(
            "/light/posts/new",
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/light/login"

    @pytest.mark.asyncio
    async def test_new_post_renders_when_authenticated(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test new post page renders when authenticated."""
        response = await client.get(
            "/light/posts/new",
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
            "/light/posts/new",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert 'name="title"' in response.text
        assert 'name="content"' in response.text
        assert 'name="status"' in response.text


class TestQuickPostCreation:
    """Test cases for Quick Post Creation (drag-and-drop) feature."""

    @pytest.mark.asyncio
    async def test_new_post_with_media_prepopulates_content(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test new post page prepopulates content with media."""
        media_id = 123
        media_path = "originals/2026/01/test_image.jpg"

        response = await client.get(
            f"/light/posts/new?media_id={media_id}&media_path={media_path}",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        # Check that markdown image reference is in the content
        assert f"![](/media/{media_path})" in response.text
        # Check that the path doesn't have duplicate "originals"
        assert "originals/originals" not in response.text

    @pytest.mark.asyncio
    async def test_new_post_with_media_sets_thumbnail(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test new post page sets initial thumbnail with media."""
        media_id = 456
        media_path = "originals/2026/01/test_photo.png"

        response = await client.get(
            f"/light/posts/new?media_id={media_id}&media_path={media_path}",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        # Check that thumbnail URL is set
        assert f"/media/{media_path}" in response.text

    @pytest.mark.asyncio
    async def test_new_post_without_media_params_works(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test new post page works normally without media parameters."""
        response = await client.get(
            "/light/posts/new",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert "New Post" in response.text
        # Should have empty content area
        assert 'name="content"' in response.text

    @pytest.mark.asyncio
    async def test_new_post_with_only_media_id(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test new post with only media_id (no media_path)."""
        response = await client.get(
            "/light/posts/new?media_id=789",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        # Should render normally without prepopulation
        assert "New Post" in response.text

    @pytest.mark.asyncio
    async def test_new_post_with_only_media_path(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test new post with only media_path (no media_id)."""
        response = await client.get(
            "/light/posts/new?media_path=originals/2026/01/test.jpg",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        # Should render normally without prepopulation
        assert "New Post" in response.text

    @pytest.mark.asyncio
    async def test_new_post_with_special_chars_in_filename(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test new post with special characters in media filename."""
        media_id = 999
        media_path = "originals/2026/01/test_image_with-dashes_123.jpg"

        response = await client.get(
            f"/light/posts/new?media_id={media_id}&media_path={media_path}",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        # Check that path is properly handled
        assert f"![](/media/{media_path})" in response.text

    @pytest.mark.asyncio
    async def test_new_post_media_path_no_duplicate_originals(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test that media path doesn't create duplicate 'originals' in URL."""
        media_id = 111
        media_path = "originals/2026/01/image.jpg"

        response = await client.get(
            f"/light/posts/new?media_id={media_id}&media_path={media_path}",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        # Verify no duplicate "originals" directory
        assert "/media/originals/originals/" not in response.text
        # Verify correct single "originals" path
        assert "/media/originals/2026/01/image.jpg" in response.text


class TestTagsPage:
    """Test cases for tags management page."""

    @pytest.mark.asyncio
    async def test_tags_page_requires_auth(self, client: AsyncClient) -> None:
        """Test tags page redirects to login without authentication."""
        response = await client.get(
            "/light/tags",
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/light/login"

    @pytest.mark.asyncio
    async def test_tags_page_renders_when_authenticated(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test tags page renders when authenticated."""
        response = await client.get(
            "/light/tags",
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
            "/light/media",
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/light/login"

    @pytest.mark.asyncio
    async def test_media_page_renders_when_authenticated(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test media page renders when authenticated."""
        response = await client.get(
            "/light/media",
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
            "/light/media",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert "No media" in response.text or "Upload" in response.text


class TestLightLogout:
    """Test cases for light logout."""

    @pytest.mark.asyncio
    async def test_logout_redirects_to_login(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test logout redirects to login page."""
        response = await client.get(
            "/light/logout",
            cookies=auth_cookies,
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/light/login"

    @pytest.mark.asyncio
    async def test_logout_clears_session_cookie(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test logout clears the session cookie."""
        response = await client.get(
            "/light/logout",
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
            "/light/posts/1",
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/light/login"

    @pytest.mark.asyncio
    async def test_edit_nonexistent_post_returns_404(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test editing non-existent post returns 404."""
        response = await client.get(
            "/light/posts/99999",
            cookies=auth_cookies,
        )

        assert response.status_code == 404


class TestLightTheming:
    """Test cases for light interface theming."""

    @pytest.mark.asyncio
    async def test_light_login_has_color_scheme_meta(
        self, client: AsyncClient
    ) -> None:
        """Test light login page has color-scheme meta tag."""
        response = await client.get("/light/login")

        assert response.status_code == 200
        assert 'name="color-scheme"' in response.text
        assert 'content="light dark"' in response.text

    @pytest.mark.asyncio
    async def test_light_dashboard_has_theme_toggle(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test light dashboard has theme toggle button."""
        response = await client.get(
            "/light/",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert 'class="theme-toggle"' in response.text

    @pytest.mark.asyncio
    async def test_light_dashboard_has_theme_icons(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test light dashboard has sun and moon theme icons."""
        response = await client.get(
            "/light/",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert 'class="icon-sun"' in response.text
        assert 'class="icon-moon"' in response.text

    @pytest.mark.asyncio
    async def test_light_loads_theme_js(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test light pages load theme.js script."""
        response = await client.get(
            "/light/",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert "/static/js/theme.js" in response.text

    @pytest.mark.asyncio
    async def test_light_posts_has_theme_toggle(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test light posts page has theme toggle."""
        response = await client.get(
            "/light/posts",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert 'class="theme-toggle"' in response.text

    @pytest.mark.asyncio
    async def test_light_tags_has_theme_toggle(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test light tags page has theme toggle."""
        response = await client.get(
            "/light/tags",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert 'class="theme-toggle"' in response.text

    @pytest.mark.asyncio
    async def test_light_media_has_theme_toggle(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test light media page has theme toggle."""
        response = await client.get(
            "/light/media",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert 'class="theme-toggle"' in response.text

    @pytest.mark.asyncio
    async def test_light_css_has_dark_theme_variables(
        self, client: AsyncClient
    ) -> None:
        """Test light CSS has dark theme variables."""
        response = await client.get("/static/css/light.css")

        assert response.status_code == 200
        assert '[data-theme="dark"]' in response.text
        assert "--light-bg" in response.text

    @pytest.mark.asyncio
    async def test_light_css_has_light_theme_variables(
        self, client: AsyncClient
    ) -> None:
        """Test light CSS has light theme variables."""
        response = await client.get("/static/css/light.css")

        assert response.status_code == 200
        assert '[data-theme="light"]' in response.text
        assert "--light-text-primary" in response.text

    @pytest.mark.asyncio
    async def test_light_has_theme_color_meta(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test light pages have theme-color meta tag."""
        response = await client.get(
            "/light/",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert 'name="theme-color"' in response.text
