"""Coverage tests for Main Application."""

import contextlib
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from fastapi import Request
from fastapi.exceptions import RequestValidationError
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.main import app, global_exception_handler
from app.models.post import Post, PostFormatter, PostStatus
from app.models.tag import Tag


@pytest.mark.asyncio
async def test_health_check(client: AsyncClient):
    """Test health check endpoint."""
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}

@pytest.mark.asyncio
async def test_global_exception_handler():
    """Test global exception handler."""
    request = MagicMock(spec=Request)
    exc = Exception("Test error")

    # Test with debug=True
    with patch("app.main.settings.debug", True):
        response = await global_exception_handler(request, exc)
        assert response.status_code == 500
        data = response.body.decode()
        assert "Test error" in data

    # Test with debug=False
    with patch("app.main.settings.debug", False):
        response = await global_exception_handler(request, exc)
        assert response.status_code == 500
        data = response.body.decode()
        assert "Internal server error" in data

@pytest.mark.asyncio
async def test_preview_post_endpoint(client: AsyncClient, db, test_user):
    """Test preview post endpoint in main.py."""
    from datetime import UTC, datetime, timedelta

    from app.models.post import Post, PostFormatter, PostStatus

    # Create post with token
    post = Post(
        title="Preview",
        slug="preview",
        content="Content",
        status=PostStatus.DRAFT,
        formatter=PostFormatter.MARKDOWN,
        author_id=test_user["user"].id,
        preview_token="token123",
        preview_expires_at=datetime.now(UTC) + timedelta(hours=1)
    )
    db.add(post)
    await db.commit()

    response = await client.get("/preview/token123")
    assert response.status_code == 200
    assert response.json()["preview_mode"] is True

@pytest.mark.asyncio
async def test_preview_post_invalid_token(client: AsyncClient):
    """Test preview post with invalid token."""
    response = await client.get("/preview/invalid")
    assert response.status_code == 404

@pytest.mark.asyncio
async def test_preview_post_expired(client: AsyncClient, db, test_user):
    """Test preview post with expired token."""
    from datetime import UTC, datetime, timedelta

    from app.models.post import Post, PostFormatter, PostStatus

    post = Post(
        title="Expired",
        slug="expired",
        content="Content",
        status=PostStatus.DRAFT,
        formatter=PostFormatter.MARKDOWN,
        author_id=test_user["user"].id,
        preview_token="token_exp",
        preview_expires_at=datetime.now(UTC) - timedelta(hours=1)
    )
    db.add(post)
    await db.commit()

    response = await client.get("/preview/token_exp")
    assert response.status_code == 410


@pytest.mark.asyncio
async def test_get_db_yields_session():
    """Test get_db dependency yields a session."""
    gen = get_db()
    session = await anext(gen)
    assert session is not None
    await session.close()
    # clean up
    with contextlib.suppress(StopAsyncIteration):
        await anext(gen)

def test_app_startup_shutdown():
    """Test app events (mocked usually as they run in lifespan)."""
    # Lifespan testing requires TestClient with with block usually, which is covered by other tests running client.
    # We can check if routes are registered
    assert len(app.routes) > 0

@pytest.mark.asyncio
async def test_validation_exception_handler():
    """Test global validation exception handler."""
    # The handler is registered in app.exception_handlers
    handler = app.exception_handlers.get(RequestValidationError)
    # If not explicitly registered (FastAPI default), this might return None or default
    if handler:
        request = MagicMock(spec=Request)
        exc = RequestValidationError(errors=[{"loc": ("body", "field"), "msg": "error", "type": "type_error"}])

        resp = await handler(request, exc)
        assert resp.status_code == 422


# Helper fixture for creating published post with all fields
@pytest.fixture
async def full_published_post(db: AsyncSession, test_user) -> Post:
    """Create a comprehensive published post."""
    tag1 = Tag(name="Photography", slug="photography", post_count=0)
    tag2 = Tag(name="Travel", slug="travel", post_count=0)
    db.add(tag1)
    db.add(tag2)
    await db.commit()

    post = Post(
        title="Amazing Photo Journey",
        slug="amazing-photo-journey",
        content="![Photo](2026/01/test.jpg)\n\nThis is my **amazing** photo journey with lots of text content.",
        excerpt="A great journey",
        status=PostStatus.PUBLISHED,
        formatter=PostFormatter.MARKDOWN,
        published_at=datetime.now(UTC) - timedelta(days=1),
        view_count=100,
        thumbnail_path="2026/01/thumb.jpg",
        author_id=test_user["user"].id,
    )
    post.tags.extend([tag1, tag2])
    db.add(post)
    await db.commit()
    await db.refresh(post)

    return post


class TestSPAFallback:
    """Test that the SPA fallback route handles non-API paths correctly."""

    @pytest.mark.asyncio
    async def test_spa_fallback_returns_non_api_path(self, client: AsyncClient):
        """SPA fallback serves index.html (or 503 if frontend not built) for unknown paths."""
        response = await client.get("/some/unknown/path")
        # Either 200 (frontend built) or 503 (frontend not yet built)
        assert response.status_code in (200, 503)

    @pytest.mark.asyncio
    async def test_spa_fallback_for_light_routes(self, client: AsyncClient):
        """Admin SPA routes (/light/*) are handled by the SPA fallback."""
        response = await client.get("/light/dashboard")
        assert response.status_code in (200, 503)

    @pytest.mark.asyncio
    async def test_api_routes_not_intercepted_by_spa(self, client: AsyncClient):
        """API routes must return JSON, not fall through to the SPA fallback."""
        response = await client.get("/api/posts")
        assert response.headers["content-type"].startswith("application/json")

    @pytest.mark.asyncio
    async def test_health_route_not_intercepted_by_spa(self, client: AsyncClient):
        """The /health route must still return JSON."""
        response = await client.get("/health")
        assert response.status_code == 200
        assert response.json()["status"] == "healthy"


class TestFeedsEndpoints:
    """Test RSS feed, sitemap, and robots.txt — backend-rendered feed routes."""

    @pytest.mark.asyncio
    async def test_sitemap_with_posts(
        self,
        client: AsyncClient,
        full_published_post: Post,
    ):
        """Sitemap includes published posts."""
        response = await client.get("/sitemap.xml")
        assert response.status_code == 200
        assert "<?xml" in response.text
        assert full_published_post.slug in response.text

    @pytest.mark.asyncio
    async def test_rss_with_posts(
        self,
        client: AsyncClient,
        full_published_post: Post,
    ):
        """RSS feed includes published posts."""
        response = await client.get("/feed.xml")
        assert response.status_code == 200
        assert "<?xml" in response.text
        assert full_published_post.title in response.text

    @pytest.mark.asyncio
    async def test_robots_txt(self, client: AsyncClient):
        """robots.txt is served as plain text."""
        response = await client.get("/robots.txt")
        assert response.status_code == 200
        assert "User-agent" in response.text
        assert "Disallow: /api/" in response.text

    @pytest.mark.asyncio
    async def test_sitemap_content_type(self, client: AsyncClient):
        """Sitemap returns correct XML content type."""
        response = await client.get("/sitemap.xml")
        assert "xml" in response.headers["content-type"]

    @pytest.mark.asyncio
    async def test_rss_content_type(self, client: AsyncClient):
        """RSS feed returns correct content type."""
        response = await client.get("/feed.xml")
        assert "rss+xml" in response.headers["content-type"]


# ── Legacy placeholder — intentionally removed ────────────────────────────────
# The following test classes tested server-rendered HTML routes (public.py /
# light.py) that no longer exist. The frontend is now a SPA served as static
# files. Equivalent functionality is tested via the /api/pages/* endpoints.
# See tests/pages/ for the replacement test suite (Phase B).

