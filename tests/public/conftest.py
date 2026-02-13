"""Shared fixtures for public API tests."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import public
from app.config import get_settings
from app.models.post import Post, PostFormatter, PostStatus
from app.models.tag import Tag
from app.services.cache_service import get_cache


@pytest.fixture
async def enable_cache():
    """Enable cache for specific tests."""
    # Get the singleton instance
    settings = get_settings()
    original_value = settings.cache_enabled

    # Force enable on the singleton
    settings.cache_enabled = True

    # Also force enable on the module-level variable in public router
    # explicitly patching the module variable
    public.settings.cache_enabled = True

    # Ensure cache directory exists
    cache = await get_cache()
    await cache.clear_all()

    yield

    # Restore
    settings.cache_enabled = original_value
    public.settings.cache_enabled = original_value
    await cache.clear_all()


@pytest.fixture
async def sample_tag(db: AsyncSession) -> Tag:
    """Create a sample tag for testing."""
    tag = Tag(
        name="Test Tag",
        slug="test-tag",
        description="A test tag for testing",
        is_important=True,
        is_featured=True,
        post_count=0,
    )
    db.add(tag)
    await db.commit()
    await db.refresh(tag)
    return tag


@pytest.fixture
async def published_post(db: AsyncSession, sample_tag: Tag, test_user: dict) -> Post:
    """Create a published post for testing."""
    post = Post(
        title="Test Published Post",
        slug="test-published-post",
        content="This is test content for the published post. ![](/media/test.jpg) <video src='/media/test.mp4'></video>",
        excerpt="Test excerpt",
        status=PostStatus.PUBLISHED,
        formatter=PostFormatter.MARKDOWN,
        published_at=datetime.now(UTC) - timedelta(hours=1),
        view_count=10,
        thumbnail_path="2026/01/test-image.jpg",
        author_id=test_user["user"].id,
    )
    post.tags.append(sample_tag)
    db.add(post)
    await db.commit()
    await db.refresh(post)
    sample_tag.post_count = 1
    await db.commit()
    return post


@pytest.fixture
async def draft_post(db: AsyncSession, test_user: dict) -> Post:
    """Create a draft post for testing."""
    post = Post(
        title="Test Draft Post",
        slug="test-draft-post",
        content="This is a draft post.",
        status=PostStatus.DRAFT,
        formatter=PostFormatter.MARKDOWN,
        author_id=test_user["user"].id,
    )
    db.add(post)
    await db.commit()
    await db.refresh(post)
    return post


@pytest.fixture
async def multiple_posts(db: AsyncSession, sample_tag: Tag, test_user: dict) -> list[Post]:
    """Create multiple published posts for testing."""
    posts = []
    for i in range(15):
        post = Post(
            title=f"Test Post {i + 1}",
            slug=f"test-post-{i + 1}",
            content=f"Content for post {i + 1}",
            excerpt=f"Excerpt for post {i + 1}",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            published_at=datetime.now(UTC) - timedelta(hours=i),
            view_count=i * 5,
            thumbnail_path=f"2026/01/image-{i + 1}.jpg" if i % 2 == 0 else None,
            author_id=test_user["user"].id,
        )
        if i < 5:
            post.tags.append(sample_tag)
        posts.append(post)
        db.add(post)
    await db.commit()
    sample_tag.post_count = 5
    await db.commit()
    return posts
