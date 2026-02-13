"""Tests for post serialization to JSON."""

from datetime import UTC, datetime

from app.api.public import serialize_post
from app.models.post import Post, PostFormatter, PostStatus
from app.models.tag import Tag


def test_serialize_post_basic(test_user: dict) -> None:
    """Test basic post serialization."""
    user = test_user["user"]
    post = Post(
        id=1, title="Test Post", slug="test-post",
        content="Content", status=PostStatus.PUBLISHED,
        author_id=user.id, created_at=datetime.now(UTC)
    )
    data = serialize_post(post)
    assert data["title"] == "Test Post"
    assert data["slug"] == "test-post"


def test_serialize_post_no_excerpt_with_media() -> None:
    """Test serialize_post generates excerpt when media is present."""
    post = Post(
        id=1, title="Media Post", slug="media-post",
        content="![](/media/test.jpg) content",
        formatter=PostFormatter.MARKDOWN,
        created_at=datetime.now(UTC),
        tags=[]
    )
    data = serialize_post(post)
    assert data["excerpt"] is not None
    assert data["has_image"] is True


def test_serialize_post_no_excerpt_no_media() -> None:
    """Test serialize_post generates preview HTML when no excerpt/media present."""
    post = Post(
        id=4, title="Text Post", slug="text-post",
        content="This is just some text content without images.",
        formatter=PostFormatter.MARKDOWN,
        created_at=datetime.now(UTC),
        tags=[]
    )
    data = serialize_post(post)
    assert data["excerpt"] is None
    assert data["preview_html"] is not None
    assert data["has_image"] is False


def test_serialize_post_hidden_parent_tag() -> None:
    """Test detection of hidden posts tag via hierarchy."""
    parent_tag = Tag(name="Hidden Parent", slug="hidden-parent", is_hidden_posts=True)
    child_tag = Tag(name="Child", slug="child")
    child_tag.parents = [parent_tag]

    post = Post(
        id=5, title="Post with Hidden Parent Tag", slug="hidden-parent-post",
        content="Content", created_at=datetime.now(UTC),
        tags=[child_tag]
    )
    data = serialize_post(post)
    assert data["has_hidden_posts_tag"] is True


def test_serialize_post_with_thumbnail_path() -> None:
    """Test serialization with explicit thumbnail path."""
    post = Post(
        id=10, title="Thumb Post", slug="thumb-post",
        content="Content",
        thumbnail_path="originals/manual-thumb.jpg",
        formatter=PostFormatter.MARKDOWN,
        created_at=datetime.now(UTC),
        tags=[]
    )
    data = serialize_post(post, use_thumbnails=False)
    assert "manual-thumb.jpg" in data["thumbnail_path"]
