"""Tests for template helper functions."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostFormatter, PostStatus
from app.models.tag import Tag
from app.utils.template_helpers import (
    post_has_hidden_posts_tag,
    tag_has_hidden_parent,
    tag_has_hidden_posts_parent,
)


@pytest.fixture
async def simple_tag(db: AsyncSession) -> Tag:
    """Create a simple tag without parents."""
    tag = Tag(
        name="Simple",
        slug="simple",
        is_hidden=False,
        is_hidden_posts=False,
        post_count=0,
    )
    db.add(tag)
    await db.commit()
    await db.refresh(tag)
    return tag


@pytest.fixture
async def hidden_tag(db: AsyncSession) -> Tag:
    """Create a hidden tag."""
    tag = Tag(
        name="Hidden",
        slug="hidden",
        is_hidden=True,
        is_hidden_posts=False,
        post_count=0,
    )
    db.add(tag)
    await db.commit()
    await db.refresh(tag)
    return tag


@pytest.fixture
async def hidden_posts_tag(db: AsyncSession) -> Tag:
    """Create a tag with is_hidden_posts=True."""
    tag = Tag(
        name="Hidden Posts",
        slug="hidden-posts",
        is_hidden=False,
        is_hidden_posts=True,
        post_count=0,
    )
    db.add(tag)
    await db.commit()
    await db.refresh(tag)
    return tag


@pytest.fixture
async def tag_with_hidden_parent(db: AsyncSession, hidden_tag: Tag) -> Tag:
    """Create a tag with a hidden parent."""
    tag = Tag(
        name="Child",
        slug="child",
        is_hidden=False,
        is_hidden_posts=False,
        post_count=0,
    )
    tag.parents.append(hidden_tag)
    db.add(tag)
    await db.commit()
    await db.refresh(tag)
    # Load parents relationship
    await tag.awaitable_attrs.parents
    return tag


@pytest.fixture
async def tag_with_hidden_posts_parent(db: AsyncSession, hidden_posts_tag: Tag) -> Tag:
    """Create a tag with a parent that has is_hidden_posts=True."""
    tag = Tag(
        name="Child Posts",
        slug="child-posts",
        is_hidden=False,
        is_hidden_posts=False,
        post_count=0,
    )
    tag.parents.append(hidden_posts_tag)
    db.add(tag)
    await db.commit()
    await db.refresh(tag)
    # Load parents relationship
    await tag.awaitable_attrs.parents
    return tag


@pytest.fixture
async def tag_hierarchy(db: AsyncSession) -> tuple[Tag, Tag, Tag]:
    """Create a 3-level tag hierarchy: grandparent -> parent -> child.

    Returns:
        Tuple of (child, parent, grandparent)
    """
    grandparent = Tag(
        name="Grandparent",
        slug="grandparent",
        is_hidden=False,
        is_hidden_posts=False,
        post_count=0,
    )
    db.add(grandparent)
    await db.commit()
    await db.refresh(grandparent)

    parent = Tag(
        name="Parent",
        slug="parent",
        is_hidden=False,
        is_hidden_posts=False,
        post_count=0,
    )
    parent.parents.append(grandparent)
    db.add(parent)
    await db.commit()
    await db.refresh(parent)

    child = Tag(
        name="Child",
        slug="child-hierarchical",
        is_hidden=False,
        is_hidden_posts=False,
        post_count=0,
    )
    child.parents.append(parent)
    db.add(child)
    await db.commit()
    await db.refresh(child)

    # Load relationships
    await child.awaitable_attrs.parents
    await parent.awaitable_attrs.parents

    return child, parent, grandparent


class TestTagHasHiddenParent:
    """Test tag_has_hidden_parent function."""

    @pytest.mark.asyncio
    async def test_tag_without_parents_returns_false(
        self, simple_tag: Tag
    ):
        """Test that a tag without parents returns False."""
        result = tag_has_hidden_parent(simple_tag)
        assert result is False

    @pytest.mark.asyncio
    async def test_hidden_tag_without_parents_returns_false(
        self, hidden_tag: Tag
    ):
        """Test that a hidden tag without parents returns False (checks parents, not self)."""
        result = tag_has_hidden_parent(hidden_tag)
        assert result is False

    @pytest.mark.asyncio
    async def test_tag_with_hidden_parent_returns_true(
        self, tag_with_hidden_parent: Tag
    ):
        """Test that a tag with a hidden parent returns True."""
        result = tag_has_hidden_parent(tag_with_hidden_parent)
        assert result is True

    @pytest.mark.asyncio
    async def test_tag_with_visible_parent_returns_false(
        self, db: AsyncSession, simple_tag: Tag
    ):
        """Test that a tag with a visible parent returns False."""
        child = Tag(
            name="Child Visible",
            slug="child-visible",
            is_hidden=False,
            is_hidden_posts=False,
            post_count=0,
        )
        child.parents.append(simple_tag)
        db.add(child)
        await db.commit()
        await child.awaitable_attrs.parents

        result = tag_has_hidden_parent(child)
        assert result is False

    def test_prevents_infinite_loop_with_circular_reference(self):
        """Test that circular references don't cause infinite loops."""
        # Create tags with circular reference (in-memory, no DB)
        tag1 = Tag(
            id=1,
            name="Tag1",
            slug="tag1",
            is_hidden=False,
            is_hidden_posts=False,
            post_count=0,
        )
        tag2 = Tag(
            id=2,
            name="Tag2",
            slug="tag2",
            is_hidden=False,
            is_hidden_posts=False,
            post_count=0,
        )

        # Set up circular reference manually (for in-memory testing)
        tag1.parents = [tag2]
        tag2.parents = [tag1]

        # Should not hang or error due to visited set
        result = tag_has_hidden_parent(tag1)
        assert result is False

    @pytest.mark.asyncio
    async def test_finds_hidden_grandparent(
        self, tag_hierarchy: tuple[Tag, Tag, Tag]
    ):
        """Test that it finds a hidden grandparent."""
        child, parent, grandparent = tag_hierarchy

        # Make grandparent hidden
        grandparent.is_hidden = True

        result = tag_has_hidden_parent(child)
        assert result is True


class TestTagHasHiddenPostsParent:
    """Test tag_has_hidden_posts_parent function."""

    @pytest.mark.asyncio
    async def test_tag_without_parents_and_not_hidden_posts_returns_false(
        self, simple_tag: Tag
    ):
        """Test that a tag without parents and is_hidden_posts=False returns False."""
        result = tag_has_hidden_posts_parent(simple_tag)
        assert result is False

    @pytest.mark.asyncio
    async def test_tag_with_is_hidden_posts_true_returns_true(
        self, hidden_posts_tag: Tag
    ):
        """Test that a tag with is_hidden_posts=True returns True."""
        result = tag_has_hidden_posts_parent(hidden_posts_tag)
        assert result is True

    @pytest.mark.asyncio
    async def test_tag_with_hidden_posts_parent_returns_true(
        self, tag_with_hidden_posts_parent: Tag
    ):
        """Test that a tag with a parent that has is_hidden_posts=True returns True."""
        result = tag_has_hidden_posts_parent(tag_with_hidden_posts_parent)
        assert result is True

    @pytest.mark.asyncio
    async def test_tag_with_visible_parent_returns_false(
        self, db: AsyncSession, simple_tag: Tag
    ):
        """Test that a tag with a visible parent returns False."""
        child = Tag(
            name="Child Visible",
            slug="child-visible-posts",
            is_hidden=False,
            is_hidden_posts=False,
            post_count=0,
        )
        child.parents.append(simple_tag)
        db.add(child)
        await db.commit()
        await child.awaitable_attrs.parents

        result = tag_has_hidden_posts_parent(child)
        assert result is False

    def test_prevents_infinite_loop_with_circular_reference(self):
        """Test that circular references don't cause infinite loops."""
        # Create tags with circular reference (in-memory, no DB)
        tag1 = Tag(
            id=1,
            name="Tag1 Posts",
            slug="tag1-posts",
            is_hidden=False,
            is_hidden_posts=False,
            post_count=0,
        )
        tag2 = Tag(
            id=2,
            name="Tag2 Posts",
            slug="tag2-posts",
            is_hidden=False,
            is_hidden_posts=False,
            post_count=0,
        )

        # Set up circular reference manually (for in-memory testing)
        tag1.parents = [tag2]
        tag2.parents = [tag1]

        # Should not hang or error due to visited set
        result = tag_has_hidden_posts_parent(tag1)
        assert result is False

    @pytest.mark.asyncio
    async def test_finds_hidden_posts_grandparent(
        self, tag_hierarchy: tuple[Tag, Tag, Tag]
    ):
        """Test that it finds a grandparent with is_hidden_posts=True."""
        child, parent, grandparent = tag_hierarchy

        # Make grandparent have is_hidden_posts=True
        grandparent.is_hidden_posts = True

        result = tag_has_hidden_posts_parent(child)
        assert result is True


class TestPostHasHiddenPostsTag:
    """Test post_has_hidden_posts_tag function."""

    @pytest.mark.asyncio
    async def test_post_without_tags_returns_false(
        self, db: AsyncSession, test_user
    ):
        """Test that a post without tags returns False."""
        post = Post(
            title="Test Post",
            slug="test-post",
            content="Content",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            author_id=test_user["user"].id,
        )
        db.add(post)
        await db.commit()
        await db.refresh(post)

        result = post_has_hidden_posts_tag(post)
        assert result is False

    @pytest.mark.asyncio
    async def test_post_with_normal_tag_returns_false(
        self, db: AsyncSession, test_user, simple_tag: Tag
    ):
        """Test that a post with a normal tag returns False."""
        post = Post(
            title="Test Post",
            slug="test-post-normal",
            content="Content",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            author_id=test_user["user"].id,
        )
        post.tags.append(simple_tag)
        db.add(post)
        await db.commit()
        await db.refresh(post)

        result = post_has_hidden_posts_tag(post)
        assert result is False

    @pytest.mark.asyncio
    async def test_post_with_hidden_posts_tag_returns_true(
        self, db: AsyncSession, test_user, hidden_posts_tag: Tag
    ):
        """Test that a post with a tag that has is_hidden_posts=True returns True."""
        post = Post(
            title="Test Post",
            slug="test-post-hidden",
            content="Content",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            author_id=test_user["user"].id,
        )
        post.tags.append(hidden_posts_tag)
        db.add(post)
        await db.commit()
        await db.refresh(post)
        await post.awaitable_attrs.tags

        result = post_has_hidden_posts_tag(post)
        assert result is True

    @pytest.mark.asyncio
    async def test_post_with_tag_that_has_hidden_posts_parent_returns_true(
        self, db: AsyncSession, test_user, tag_with_hidden_posts_parent: Tag
    ):
        """Test that a post with a tag whose parent has is_hidden_posts=True returns True."""
        post = Post(
            title="Test Post",
            slug="test-post-parent-hidden",
            content="Content",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            author_id=test_user["user"].id,
        )
        post.tags.append(tag_with_hidden_posts_parent)
        db.add(post)
        await db.commit()
        await db.refresh(post)
        await post.awaitable_attrs.tags
        # Load tag parents
        for tag in post.tags:
            await tag.awaitable_attrs.parents

        result = post_has_hidden_posts_tag(post)
        assert result is True

    @pytest.mark.asyncio
    async def test_post_with_mixed_tags_returns_true_if_any_hidden(
        self, db: AsyncSession, test_user, simple_tag: Tag, hidden_posts_tag: Tag
    ):
        """Test that a post returns True if any tag has is_hidden_posts=True."""
        post = Post(
            title="Test Post",
            slug="test-post-mixed",
            content="Content",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            author_id=test_user["user"].id,
        )
        post.tags.extend([simple_tag, hidden_posts_tag])
        db.add(post)
        await db.commit()
        await db.refresh(post)
        await post.awaitable_attrs.tags

        result = post_has_hidden_posts_tag(post)
        assert result is True
