"""Tests for post-tag relationship operations."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostStatus
from app.models.tag import Tag
from app.services.tag_service import TagService


@pytest.fixture
def tag_service(db: AsyncSession):
    """Create tag service instance."""
    return TagService(db)


class TestSetPostTags:
    """Test setting tags on posts."""

    @pytest.mark.asyncio
    async def test_set_post_tags_create_new(
        self, tag_service: TagService, db: AsyncSession
    ):
        """Test setting post tags creates new tags."""
        post = Post(title="P", slug="p", content="C", author_id=1)
        db.add(post)
        await db.commit()
        await db.refresh(post, ["tags"])  # Load tags

        tags = await tag_service.set_post_tags(post, ["New Tag 1", "New Tag 2"])

        assert len(tags) == 2
        assert {t.name for t in tags} == {"New Tag 1", "New Tag 2"}

    @pytest.mark.asyncio
    async def test_set_post_tags_existing(
        self, tag_service: TagService, db: AsyncSession
    ):
        """Test setting post tags uses existing tags."""
        tag1 = Tag(name="Existing", slug="existing", post_count=0)
        db.add(tag1)
        await db.commit()

        post = Post(title="P", slug="p", content="C", author_id=1)
        db.add(post)
        await db.commit()
        await db.refresh(post, ["tags"])  # Load tags

        tags = await tag_service.set_post_tags(post, ["Existing", "New"])

        assert len(tags) == 2
        tag_names = {t.name for t in tags}
        assert "Existing" in tag_names
        assert "New" in tag_names


class TestAddTagsToPost:
    """Test adding tags to posts."""

    @pytest.mark.asyncio
    async def test_add_tags_empty_string(self, db: AsyncSession):
        """Test adding tags with empty strings ignored."""
        service = TagService(db)
        user_id = 1  # Dummy
        post = Post(
            title="T", slug="t", content="c", status=PostStatus.DRAFT, author_id=user_id
        )
        db.add(post)
        await db.commit()
        await db.refresh(post, attribute_names=["tags"])

        tags = await service.add_tags_to_post(post, ["Valid", "  ", ""])
        assert len(tags) == 1
        assert tags[0].name == "Valid"


class TestRemoveTagsFromPost:
    """Test removing tags from posts."""

    @pytest.mark.asyncio
    async def test_remove_tags_from_post(
        self, tag_service: TagService, db: AsyncSession
    ):
        """Test removing tags from post."""
        tag1 = Tag(name="Tag1", slug="tag1", post_count=1)
        post = Post(title="P", slug="p", content="C", author_id=1)
        post.tags.append(tag1)
        db.add_all([tag1, post])
        await db.commit()
        await db.refresh(post, ["tags"])

        await tag_service.remove_tags_from_post(post, [tag1.id])
        assert len(post.tags) == 0

        await db.refresh(tag1)
        assert tag1.post_count == 0

    @pytest.mark.asyncio
    async def test_remove_tags_updates_counts(self, db: AsyncSession):
        """Test that removing tags updates their post counts."""
        service = TagService(db)
        user_id = 1
        post = Post(
            title="T",
            slug="t",
            content="c",
            status=PostStatus.PUBLISHED,
            author_id=user_id,
        )
        db.add(post)
        await db.commit()
        await db.refresh(post, attribute_names=["tags"])

        # Add tags
        await service.set_post_tags(post, ["Tag1", "Tag2"])

        t1 = await service.get_tag_by_name("Tag1")
        t2 = await service.get_tag_by_name("Tag2")

        assert t1.post_count == 1
        assert t2.post_count == 1

        # Remove Tag1
        await service.remove_tags_from_post(post, [t1.id])
        await db.refresh(t1)
        await db.refresh(t2)

        assert t1.post_count == 0
        assert t2.post_count == 1
