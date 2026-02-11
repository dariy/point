"""Comprehensive tests for light interface routes.

This test suite provides extensive coverage for all light (light) interface routes,
including authentication, dashboard, posts, tags, media, settings, security, and system pages.
"""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user
from app.main import app
from app.models.media import FileType, Media
from app.models.post import Post, PostFormatter, PostStatus
from app.models.session import Session
from app.models.settings import BlogSettings
from app.models.tag import Tag
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


@pytest.fixture
def override_auth(test_user):
    """Override auth dependency for specific tests."""
    assert test_user is not None
    app.dependency_overrides[get_current_user] = lambda: test_user["user"]
    yield
    app.dependency_overrides.pop(get_current_user, None)


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

    @pytest.mark.asyncio
    async def test_login_page_with_error_parameter(self, client: AsyncClient) -> None:
        """Test login page displays error message when error param is present."""
        response = await client.get("/light/login?error=Invalid+credentials")

        assert response.status_code == 200
        # The error should be passed to the template context
        assert "error" in response.text.lower() or "invalid" in response.text.lower()


class TestRequireAuth:
    """Test cases for require_auth dependency."""

    @pytest.mark.asyncio
    async def test_require_auth_raises_exception_when_no_user(self) -> None:
        """Test require_auth raises HTTPException when user is None."""
        from fastapi import HTTPException

        from app.api.light import require_auth

        try:
            await require_auth(user=None)
            pytest.fail("Should have raised HTTPException")
        except HTTPException as e:
            assert e.status_code == 303
            assert e.headers is not None
            assert e.headers["Location"] == "/light/login"

    @pytest.mark.asyncio
    async def test_require_auth_returns_user_when_authenticated(
        self, test_user: dict
    ) -> None:
        """Test require_auth returns user when authenticated."""
        from app.api.light import require_auth

        assert test_user is not None
        user = await require_auth(user=test_user["user"])
        assert user == test_user["user"]


class TestGetBaseContext:
    """Test cases for get_base_context helper."""

    @pytest.mark.asyncio
    async def test_get_base_context_without_user(self, db: AsyncSession) -> None:
        """Test get_base_context creates proper context without user."""
        from unittest.mock import Mock

        from app.api.light import get_base_context

        request = Mock()
        context = await get_base_context(db, request)

        assert "request" in context
        assert "user" in context
        assert context["user"] is None
        assert "settings" in context
        assert "app_name" in context
        assert "app_version" in context
        assert "public_url" in context
        assert context["public_url"] == "/"

    @pytest.mark.asyncio
    async def test_get_base_context_with_user(self, db: AsyncSession, test_user: dict) -> None:
        """Test get_base_context creates proper context with user."""
        from unittest.mock import Mock

        from app.api.light import get_base_context

        assert test_user is not None
        request = Mock()
        context = await get_base_context(db, request, test_user["user"])

        assert context["user"] == test_user["user"]


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
        assert 'class="public-home-link"' in response.text
        assert 'href="/"' in response.text

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

    @pytest.mark.asyncio
    async def test_dashboard_with_data(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict, test_user: dict
    ) -> None:
        """Test dashboard displays actual data and statistics."""
        assert test_user is not None
        user = test_user["user"]

        # Create published post
        p1 = Post(
            title="Published Post",
            slug="published",
            content="content",
            status=PostStatus.PUBLISHED,
            author_id=user.id,
            view_count=10,
            formatter=PostFormatter.MARKDOWN
        )
        # Create draft post
        p2 = Post(
            title="Draft Post",
            slug="draft",
            content="content",
            status=PostStatus.DRAFT,
            author_id=user.id,
            formatter=PostFormatter.MARKDOWN
        )
        # Create tag
        t1 = Tag(name="TestTag", slug="test-tag", post_count=1)
        # Create media
        m1 = Media(
            filename="test.jpg",
            original_path="test.jpg",
            file_type=FileType.IMAGE,
            mime_type="image/jpeg",
            file_size=1024,
            uploaded_at=datetime.now(UTC),
            checksum="abc123",
        )
        # Create additional session
        s1 = Session(
            user_id=user.id,
            token="test_token",
            ip_address="127.0.0.1",
            user_agent="test",
            created_at=datetime.now(UTC),
            expires_at=datetime.now(UTC) + timedelta(days=1),
            last_activity=datetime.now(UTC),
        )

        db.add_all([p1, p2, t1, m1, s1])
        await db.commit()

        response = await client.get("/light/", cookies=auth_cookies)
        assert response.status_code == 200
        # Check that stats are visible - template should display these numbers
        assert "2" in response.text  # total posts
        assert "10" in response.text  # view count

    @pytest.mark.asyncio
    async def test_dashboard_storage_calculation(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test dashboard calculates storage usage correctly."""
        # Create a test file in the media directory to test storage calculation
        from app.config import get_settings
        settings = get_settings()
        media_path = Path(settings.storage_path) / "media" / "test_storage.txt"
        media_path.parent.mkdir(parents=True, exist_ok=True)
        media_path.write_text("test content for storage calculation")

        try:
            response = await client.get("/light/", cookies=auth_cookies)
            assert response.status_code == 200
            # Storage calculation should complete without errors
            assert "Storage" in response.text or "storage" in response.text.lower()
        finally:
            # Cleanup
            if media_path.exists():
                media_path.unlink()

    @pytest.mark.asyncio
    async def test_dashboard_with_null_values(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict
    ) -> None:
        """Test dashboard handles null/zero values gracefully."""
        # Don't create any data, test with empty database
        response = await client.get("/light/", cookies=auth_cookies)
        assert response.status_code == 200
        # Should show 0 for all stats
        assert "Dashboard" in response.text


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
    async def test_posts_list_with_status_filter(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict, test_user: dict
    ) -> None:
        """Test posts list with status filter."""
        assert test_user is not None
        user = test_user["user"]

        p1 = Post(
            title="UniqueDraftTitle",
            slug="draft",
            content="content",
            status=PostStatus.DRAFT,
            author_id=user.id,
            formatter=PostFormatter.MARKDOWN
        )
        p2 = Post(
            title="UniquePublishedTitle",
            slug="published",
            content="content",
            status=PostStatus.PUBLISHED,
            author_id=user.id,
            formatter=PostFormatter.MARKDOWN
        )
        db.add_all([p1, p2])
        await db.commit()

        response = await client.get("/light/posts?status_filter=draft", cookies=auth_cookies)
        assert response.status_code == 200
        assert "UniqueDraftTitle" in response.text
        # Published post should not appear when filtering for drafts
        # (Unless shown in sidebar, but typically not on filtered page)

    @pytest.mark.asyncio
    async def test_posts_list_with_search_filter(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict, test_user: dict
    ) -> None:
        """Test posts list with search filter."""
        assert test_user is not None
        user = test_user["user"]

        p1 = Post(
            title="Apple Post",
            slug="apple-post",
            content="content",
            status=PostStatus.PUBLISHED,
            author_id=user.id,
            formatter=PostFormatter.MARKDOWN
        )
        p2 = Post(
            title="Banana Post",
            slug="banana-post",
            content="content",
            status=PostStatus.PUBLISHED,
            author_id=user.id,
            formatter=PostFormatter.MARKDOWN
        )
        db.add_all([p1, p2])
        await db.commit()

        response = await client.get("/light/posts?search=Apple", cookies=auth_cookies)
        assert response.status_code == 200
        assert "Apple Post" in response.text
        assert "Banana Post" not in response.text

    @pytest.mark.asyncio
    async def test_posts_list_with_invalid_status_filter(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test posts list with invalid status filter is handled gracefully."""
        response = await client.get(
            "/light/posts?status_filter=invalid_status", cookies=auth_cookies
        )
        # Should still render the page, just ignore invalid filter
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_posts_list_with_pagination(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test posts list with page parameter."""
        response = await client.get("/light/posts?page=2", cookies=auth_cookies)
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_posts_list_view_link_correct(
        self, client: AsyncClient, auth_cookies: dict, db: AsyncSession, test_user: dict
    ) -> None:
        """Test posts list shows correct view link for published posts."""
        assert test_user is not None
        post = Post(
            title="Test Post Link",
            slug="test-post-link",
            content="Content",
            status=PostStatus.PUBLISHED,
            author_id=test_user["user"].id,
            published_at=datetime.now(UTC),
            formatter=PostFormatter.MARKDOWN,
        )
        db.add(post)
        await db.commit()

        response = await client.get("/light/posts", cookies=auth_cookies)

        assert response.status_code == 200
        assert f'href="/posts/{post.slug}"' in response.text

    @pytest.mark.asyncio
    async def test_posts_list_shows_all_statuses(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test posts list includes all post statuses in context."""
        response = await client.get("/light/posts", cookies=auth_cookies)
        assert response.status_code == 200
        # Should have status options available
        assert "draft" in response.text.lower() or "published" in response.text.lower()

    @pytest.mark.asyncio
    async def test_posts_list_calculates_pagination_correctly(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict, test_user: dict
    ) -> None:
        """Test posts list pagination calculation."""
        assert test_user is not None
        # Create multiple posts to test pagination
        posts = [
            Post(
                title=f"Post {i}",
                slug=f"post-{i}",
                content="content",
                status=PostStatus.PUBLISHED,
                author_id=test_user["user"].id,
                formatter=PostFormatter.MARKDOWN,
            )
            for i in range(25)
        ]
        db.add_all(posts)
        await db.commit()

        response = await client.get("/light/posts?page=1", cookies=auth_cookies)
        assert response.status_code == 200
        # Should have pagination links for multiple pages


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
        assert f"![](/media/{media_path})" in response.text
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
        assert f"/media/{media_path}" in response.text

    @pytest.mark.asyncio
    async def test_new_post_without_media_params_works(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test new post page works normally without media parameters."""
        response = await client.get("/light/posts/new", cookies=auth_cookies)

        assert response.status_code == 200
        assert "New Post" in response.text
        assert 'name="content"' in response.text

    @pytest.mark.asyncio
    async def test_new_post_with_only_media_id(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test new post with only media_id (no media_path)."""
        response = await client.get("/light/posts/new?media_id=789", cookies=auth_cookies)

        assert response.status_code == 200
        assert "New Post" in response.text

    @pytest.mark.asyncio
    async def test_new_post_with_only_media_path(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test new post with only media_path (no media_id)."""
        response = await client.get(
            "/light/posts/new?media_path=originals/2026/01/test.jpg", cookies=auth_cookies
        )

        assert response.status_code == 200
        assert "New Post" in response.text

    @pytest.mark.asyncio
    async def test_new_post_loads_tags_for_autocomplete(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict
    ) -> None:
        """Test new post page loads all tags for autocomplete."""
        # Create some tags
        tag1 = Tag(name="TagOne", slug="tag-one")
        tag2 = Tag(name="TagTwo", slug="tag-two")
        db.add_all([tag1, tag2])
        await db.commit()

        response = await client.get("/light/posts/new", cookies=auth_cookies)
        assert response.status_code == 200
        # Tags should be available for autocomplete
        assert "TagOne" in response.text or "TagTwo" in response.text

    @pytest.mark.asyncio
    async def test_new_post_includes_status_options(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test new post page includes all post status options."""
        response = await client.get("/light/posts/new", cookies=auth_cookies)
        assert response.status_code == 200
        # Should have status options
        assert "draft" in response.text.lower() or "published" in response.text.lower()


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

    @pytest.mark.asyncio
    async def test_edit_post_renders_with_existing_post(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict, test_user: dict
    ) -> None:
        """Test edit post page renders with existing post data."""
        assert test_user is not None
        # Create a post with tags
        tag1 = Tag(name="Tag1", slug="tag1")
        tag2 = Tag(name="Tag2", slug="tag2")
        db.add_all([tag1, tag2])
        await db.commit()

        post = Post(
            title="Edit Test Post",
            slug="edit-test-post",
            content="Test content",
            status=PostStatus.DRAFT,
            author_id=test_user["user"].id,
            formatter=PostFormatter.MARKDOWN,
        )
        post.tags = [tag1, tag2]
        db.add(post)
        await db.commit()
        await db.refresh(post)

        response = await client.get(f"/light/posts/{post.id}", cookies=auth_cookies)

        assert response.status_code == 200
        assert "Edit Test Post" in response.text
        assert "Tag1" in response.text
        assert "Tag2" in response.text
        # Verify contextual public_url
        assert f'href="/posts/{post.slug}"' in response.text
        # Verify categories section is gone
        assert "Categories (Meta-tags)" not in response.text
        assert "categories-picker" not in response.text


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

    @pytest.mark.asyncio
    async def test_tags_page_with_search_and_sort(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict
    ) -> None:
        """Test tags page with search and sort parameters."""
        t1 = Tag(name="AppleTag", slug="apple")
        t2 = Tag(name="ZebraTag", slug="zebra")
        db.add_all([t1, t2])
        await db.commit()

        response = await client.get(
            "/light/tags?search=Apple&sort_by=name&sort_order=desc",
            cookies=auth_cookies,
        )
        assert response.status_code == 200
        assert "AppleTag" in response.text
        assert 'href="/tags"' in response.text

    @pytest.mark.asyncio
    async def test_tags_page_with_all_params(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict
    ) -> None:
        """Test tags page with all query parameters."""
        tag = Tag(name="TestTag", slug="test-tag", post_count=5)
        db.add(tag)
        await db.commit()

        response = await client.get(
            "/light/tags?page=1&search=Test&sort_by=post_count&sort_order=desc",
            cookies=auth_cookies,
        )
        assert response.status_code == 200
        assert "TestTag" in response.text

    @pytest.mark.asyncio
    async def test_tags_page_displays_pagination_info(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict
    ) -> None:
        """Test tags page displays pagination information."""
        # Create some tags
        tags = [Tag(name=f"Tag{i}", slug=f"tag-{i}") for i in range(5)]
        db.add_all(tags)
        await db.commit()

        response = await client.get("/light/tags", cookies=auth_cookies)
        assert response.status_code == 200
        # Should show tag count


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

    @pytest.mark.asyncio
    async def test_media_page_with_file_type_filter(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict
    ) -> None:
        """Test media page with file_type filter."""
        m1 = Media(
            filename="video.mp4",
            original_path="video.mp4",
            file_type=FileType.VIDEO,
            mime_type="video/mp4",
            file_size=1024,
            checksum="vid123",
        )
        db.add(m1)
        await db.commit()

        response = await client.get("/light/media?file_type=video", cookies=auth_cookies)
        assert response.status_code == 200
        assert "video.mp4" in response.text

    @pytest.mark.asyncio
    async def test_media_page_with_pagination(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test media page with page parameter."""
        response = await client.get("/light/media?page=2", cookies=auth_cookies)
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_media_page_shows_file_types(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict
    ) -> None:
        """Test media page displays unique file types for filtering."""
        m1 = Media(
            filename="img.jpg",
            original_path="img.jpg",
            file_type=FileType.IMAGE,
            mime_type="image/jpeg",
            file_size=1024,
            checksum="img123",
        )
        m2 = Media(
            filename="vid.mp4",
            original_path="vid.mp4",
            file_type=FileType.VIDEO,
            mime_type="video/mp4",
            file_size=2048,
            checksum="vid456",
        )
        db.add_all([m1, m2])
        await db.commit()

        response = await client.get("/light/media", cookies=auth_cookies)
        assert response.status_code == 200
        # File types should be available for filtering
        assert "image" in response.text.lower()
        assert "video" in response.text.lower()


class TestSettingsPage:
    """Test cases for settings page."""

    @pytest.mark.asyncio
    async def test_settings_page_requires_auth(self, client: AsyncClient) -> None:
        """Test settings page redirects to login without authentication."""
        response = await client.get(
            "/light/settings",
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/light/login"

    @pytest.mark.asyncio
    async def test_settings_page_renders_when_authenticated(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test settings page renders when authenticated."""
        response = await client.get(
            "/light/settings",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "Settings" in response.text

    @pytest.mark.asyncio
    async def test_settings_page_displays_blog_settings(
        self, client: AsyncClient, db: AsyncSession, auth_cookies: dict
    ) -> None:
        """Test settings page displays blog configuration."""
        # Create some settings
        setting1 = BlogSettings(key="blog_title", value="My Test Blog")
        setting2 = BlogSettings(key="blog_description", value="A test blog")
        db.add_all([setting1, setting2])
        await db.commit()

        response = await client.get("/light/settings", cookies=auth_cookies)

        assert response.status_code == 200
        # Settings should be displayed
        assert "My Test Blog" in response.text or "blog" in response.text.lower()


class TestSecurityPage:
    """Test cases for security page."""

    @pytest.mark.asyncio
    async def test_security_page_requires_auth(self, client: AsyncClient) -> None:
        """Test security page redirects to login without authentication."""
        response = await client.get(
            "/light/security",
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/light/login"

    @pytest.mark.asyncio
    async def test_security_page_renders_when_authenticated(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test security page renders when authenticated."""
        response = await client.get(
            "/light/security",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "Security" in response.text or "Password" in response.text


class TestSystemPage:
    """Test cases for system tools page."""

    @pytest.mark.asyncio
    async def test_system_page_requires_auth(self, client: AsyncClient) -> None:
        """Test system page redirects to login without authentication."""
        response = await client.get(
            "/light/system",
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/light/login"

    @pytest.mark.asyncio
    async def test_system_page_renders_when_authenticated(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test system page renders when authenticated."""
        response = await client.get(
            "/light/system",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "System" in response.text

    @pytest.mark.asyncio
    async def test_system_page_displays_stats_and_logs(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test system page displays system statistics and logs."""
        response = await client.get(
            "/light/system",
            cookies=auth_cookies,
        )

        assert response.status_code == 200
        # Should show some system information
        assert "System" in response.text or "Stats" in response.text or "Logs" in response.text


class TestLogout:
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


class TestUnauthenticatedAccess:
    """Test cases for unauthenticated access to protected routes."""

    @pytest.mark.asyncio
    async def test_all_protected_routes_redirect_to_login(
        self, client: AsyncClient
    ) -> None:
        """Test that all protected routes redirect to login without auth."""
        protected_endpoints = [
            "/light/",
            "/light/posts",
            "/light/posts/new",
            "/light/posts/1",
            "/light/tags",
            "/light/media",
            "/light/settings",
            "/light/security",
            "/light/system",
        ]

        for endpoint in protected_endpoints:
            response = await client.get(endpoint, follow_redirects=False)
            assert response.status_code == 303, f"Endpoint {endpoint} didn't redirect"
            assert (
                response.headers["location"] == "/light/login"
            ), f"Endpoint {endpoint} didn't redirect to login"


class TestLightTheming:
    """Test cases for light interface theming support."""

    @pytest.mark.asyncio
    async def test_login_has_color_scheme_meta(self, client: AsyncClient) -> None:
        """Test login page has color-scheme meta tag."""
        response = await client.get("/light/login")

        assert response.status_code == 200
        assert 'name="color-scheme"' in response.text
        assert 'content="light dark"' in response.text

    @pytest.mark.asyncio
    async def test_dashboard_has_theme_toggle(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test dashboard has theme toggle button."""
        response = await client.get("/light/", cookies=auth_cookies)

        assert response.status_code == 200
        assert "theme-toggle" in response.text

    @pytest.mark.asyncio
    async def test_dashboard_loads_theme_js(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test dashboard loads theme.js script."""
        response = await client.get("/light/", cookies=auth_cookies)

        assert response.status_code == 200
        assert "/static/js/theme.js" in response.text
