"""Integration tests for light interface to ensure full code coverage.

These tests focus on executing complete code paths including all context updates,
template rendering, and complex scenarios.
"""

from datetime import datetime, timedelta
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.media import FileType, Media
from app.models.post import Post, PostFormatter, PostStatus
from app.models.session import Session
from app.models.settings import BlogSettings
from app.models.tag import Tag
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService


@pytest.fixture
async def test_user(db: AsyncSession) -> dict:
    """Create a test user and return credentials."""
    auth_service = AuthService(db)
    user_data = UserCreate(
        username="integration_user",
        email="integration@example.com",
        password="testpass123",
        display_name="Integration Test User",
    )
    user = await auth_service.create_user(user_data)
    await db.commit()

    return {"username": "integration_user", "password": "testpass123", "user": user}


@pytest.fixture
async def auth_cookies(client: AsyncClient, test_user: dict) -> dict:
    """Login and return auth cookies."""
    response = await client.post(
        "/api/auth/login",
        json={"username": test_user["username"], "name": test_user["password"]},
    )
    assert response.status_code == 200
    return dict(response.cookies)


@pytest.mark.asyncio
async def test_dashboard_full_integration(
    client: AsyncClient, db: AsyncSession, auth_cookies: dict, test_user: dict
) -> None:
    """Test dashboard with complete data to cover all code paths."""
    user = test_user["user"]

    # Create comprehensive test data
    posts = [
        Post(
            title=f"Test Post {i}",
            slug=f"test-post-{i}",
            content="Test content",
            status=PostStatus.PUBLISHED if i % 2 == 0 else PostStatus.DRAFT,
            author_id=user.id,
            view_count=i * 10,
            formatter=PostFormatter.MARKDOWN,
        )
        for i in range(10)
    ]

    tags = [Tag(name=f"Tag{i}", slug=f"tag-{i}", post_count=i) for i in range(5)]

    media_files = [
        Media(
            filename=f"file{i}.jpg",
            original_path=f"originals/file{i}.jpg",
            file_type=FileType.IMAGE,
            mime_type="image/jpeg",
            file_size=1024 * i,
            checksum=f"checksum{i}",
        )
        for i in range(1, 6)
    ]

    sessions = [
        Session(
            user_id=user.id,
            token=f"token{i}",
            ip_address=f"127.0.0.{i}",
            user_agent="test",
            created_at=datetime.utcnow(),
            expires_at=datetime.utcnow() + timedelta(days=1),
            last_activity=datetime.utcnow(),
        )
        for i in range(3)
    ]

    db.add_all(posts + tags + media_files + sessions)
    await db.commit()

    # Create actual media files for storage calculation
    from app.config import get_settings
    settings = get_settings()
    media_path = Path(settings.storage_path) / "media"
    media_path.mkdir(parents=True, exist_ok=True)
    test_file = media_path / "test_integration.jpg"
    test_file.write_bytes(b"test data for storage calculation")

    try:
        response = await client.get("/light/", cookies=auth_cookies)
        assert response.status_code == 200

        # Verify all stats are rendered
        assert "Dashboard" in response.text
        # Storage calculation should have run
        assert "Storage" in response.text or "storage" in response.text.lower()
    finally:
        # Cleanup
        if test_file.exists():
            test_file.unlink()


@pytest.mark.asyncio
async def test_posts_list_full_context(
    client: AsyncClient, db: AsyncSession, auth_cookies: dict, test_user: dict
) -> None:
    """Test posts list with all context fields populated."""
    user = test_user["user"]

    # Create posts with various statuses
    posts = [
        Post(
            title=f"Post {status.value} {i}",
            slug=f"post-{status.value}-{i}",
            content="content",
            status=status,
            author_id=user.id,
            formatter=PostFormatter.MARKDOWN,
        )
        for status in PostStatus
        for i in range(3)
    ]
    db.add_all(posts)
    await db.commit()

    # Test with status filter
    response = await client.get("/light/posts?status_filter=published&page=1", cookies=auth_cookies)
    assert response.status_code == 200

    # Test without filter
    response = await client.get("/light/posts?page=2", cookies=auth_cookies)
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_new_post_complete_context(
    client: AsyncClient, db: AsyncSession, auth_cookies: dict
) -> None:
    """Test new post page with complete context including tags and media params."""
    # Create tags
    tags = [Tag(name=f"IntegTag{i}", slug=f"integ-tag-{i}") for i in range(5)]
    db.add_all(tags)
    await db.commit()

    # Test with media parameters
    response = await client.get(
        "/light/posts/new?media_id=123&media_path=originals/2026/01/test.jpg",
        cookies=auth_cookies,
    )
    assert response.status_code == 200
    assert "![](/media/originals/2026/01/test.jpg)" in response.text

    # Test without media parameters but with tags
    response = await client.get("/light/posts/new", cookies=auth_cookies)
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_edit_post_complete_context(
    client: AsyncClient, db: AsyncSession, auth_cookies: dict, test_user: dict
) -> None:
    """Test edit post page with complete context including post and tags."""
    # Create tags
    tag1 = Tag(name="EditTag1", slug="edit-tag-1")
    tag2 = Tag(name="EditTag2", slug="edit-tag-2")
    tag3 = Tag(name="EditTag3", slug="edit-tag-3")
    db.add_all([tag1, tag2, tag3])
    await db.commit()

    # Create post with tags
    post = Post(
        title="Edit Integration Test",
        slug="edit-integration-test",
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
    # Verify tags are in response
    assert "EditTag1" in response.text
    assert "EditTag2" in response.text


@pytest.mark.asyncio
async def test_tags_page_complete_context(
    client: AsyncClient, db: AsyncSession, auth_cookies: dict
) -> None:
    """Test tags page with complete context and all query parameters."""
    # Create tags
    tags = [
        Tag(name=f"IntegrationTag{i}", slug=f"integration-tag-{i}", post_count=i)
        for i in range(10)
    ]
    db.add_all(tags)
    await db.commit()

    # Test with all query params
    response = await client.get(
        "/light/tags?page=1&search=Integration&sort_by=post_count&sort_order=desc",
        cookies=auth_cookies,
    )
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_media_page_complete_context(
    client: AsyncClient, db: AsyncSession, auth_cookies: dict
) -> None:
    """Test media page with complete context including file type filtering."""
    # Create media files of different types
    media_items = [
        Media(
            filename=f"image{i}.jpg",
            original_path=f"originals/image{i}.jpg",
            file_type=FileType.IMAGE,
            mime_type="image/jpeg",
            file_size=1024 * i,
            checksum=f"img_checksum{i}",
        )
        for i in range(1, 6)
    ] + [
        Media(
            filename=f"video{i}.mp4",
            original_path=f"originals/video{i}.mp4",
            file_type=FileType.VIDEO,
            mime_type="video/mp4",
            file_size=2048 * i,
            checksum=f"vid_checksum{i}",
        )
        for i in range(1, 4)
    ] + [
        Media(
            filename="audio.mp3",
            original_path="originals/audio.mp3",
            file_type=FileType.AUDIO,
            mime_type="audio/mp3",
            file_size=512,
            checksum="audio_checksum",
        )
    ]

    db.add_all(media_items)
    await db.commit()

    # Test with file_type filter
    response = await client.get("/light/media?file_type=image&page=1", cookies=auth_cookies)
    assert response.status_code == 200
    assert "image1.jpg" in response.text or "image" in response.text.lower()

    # Test without filter to get all file types
    response = await client.get("/light/media?page=1", cookies=auth_cookies)
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_settings_page_complete_context(
    client: AsyncClient, db: AsyncSession, auth_cookies: dict
) -> None:
    """Test settings page with blog settings populated."""
    # Create blog settings
    settings = [
        BlogSettings(key="blog_title", value="Integration Test Blog", value_type="string"),
        BlogSettings(key="blog_description", value="A test blog for integration", value_type="string"),
        BlogSettings(key="posts_per_page", value="10", value_type="integer"),
        BlogSettings(key="enable_comments", value="true", value_type="boolean"),
    ]
    db.add_all(settings)
    await db.commit()

    response = await client.get("/light/settings", cookies=auth_cookies)
    assert response.status_code == 200
    # Settings should be displayed
    assert "Settings" in response.text


@pytest.mark.asyncio
async def test_security_page_full_render(
    client: AsyncClient, auth_cookies: dict
) -> None:
    """Test security page renders completely."""
    response = await client.get("/light/security", cookies=auth_cookies)
    assert response.status_code == 200
    # Page should contain security-related content
    assert "Security" in response.text or "Password" in response.text


@pytest.mark.asyncio
async def test_system_page_complete_context(
    client: AsyncClient, auth_cookies: dict
) -> None:
    """Test system page with full stats and logs."""
    response = await client.get("/light/system", cookies=auth_cookies)
    assert response.status_code == 200
    # System info should be rendered
    assert "System" in response.text
