"""Tests for tag service operations."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostStatus
from app.models.tag import Tag
from app.schemas.tag import TagCreate, TagUpdate
from app.services.tag_service import TagService


@pytest.fixture
def tag_service(db: AsyncSession):
    """Create tag service instance."""
    return TagService(db)


class TestTagCreation:
    """Test tag creation operations."""

    @pytest.mark.asyncio
    async def test_create_tag_duplicate_name(self, tag_service: TagService, db: AsyncSession):
        """Test creating tag with duplicate name raises ValueError."""
        tag1 = Tag(name="Tag 1", slug="tag-1", post_count=0)
        db.add(tag1)
        await db.commit()

        # Create tag with same name
        tag_data = TagCreate(name="Tag 1")
        with pytest.raises(ValueError):
            await tag_service.create_tag(tag_data)


class TestTagUpdate:
    """Test tag update operations."""

    @pytest.mark.asyncio
    async def test_update_tag_conflict(self, tag_service: TagService, db: AsyncSession):
        """Test updating tag name to an existing one raises ValueError."""
        tag1 = Tag(name="Tag 1", slug="tag-1", post_count=0)
        tag2 = Tag(name="Tag 2", slug="tag-2", post_count=0)
        db.add_all([tag1, tag2])
        await db.commit()

        with pytest.raises(ValueError):
            await tag_service.update_tag(tag1.id, TagUpdate(name="Tag 2"))

    @pytest.mark.asyncio
    async def test_update_tag_slug_conflict(self, tag_service: TagService, db: AsyncSession):
        """Test updating tag slug to an existing one raises ValueError."""
        tag1 = Tag(name="Tag 1", slug="tag-1", post_count=0)
        tag2 = Tag(name="Tag 2", slug="tag-2", post_count=0)
        db.add_all([tag1, tag2])
        await db.commit()

        with pytest.raises(ValueError):
            await tag_service.update_tag(tag1.id, TagUpdate(slug="tag-2"))

    @pytest.mark.asyncio
    async def test_update_tag_not_found_service(self, db: AsyncSession):
        """Test updating a non-existent tag returns None."""
        service = TagService(db)
        result = await service.update_tag(999, TagUpdate(name="New"))
        assert result is None

    @pytest.mark.asyncio
    async def test_update_tag_name_conflict_explicit(self, db: AsyncSession):
        """Test updating tag name to existing one raises ValueError."""
        service = TagService(db)
        t1 = await service.create_tag(TagCreate(name="Tag1"))
        await service.create_tag(TagCreate(name="Tag2"))

        with pytest.raises(ValueError):
            await service.update_tag(t1.id, TagUpdate(name="Tag2"))

    @pytest.mark.asyncio
    async def test_update_tag_slug_conflict_explicit(self, db: AsyncSession):
        """Test updating tag slug to existing one raises ValueError."""
        service = TagService(db)
        t1 = await service.create_tag(TagCreate(name="Tag1"))
        t2 = await service.create_tag(TagCreate(name="Tag2"))

        with pytest.raises(ValueError):
            await service.update_tag(t1.id, TagUpdate(slug=t2.slug))


class TestTagDelete:
    """Test tag deletion operations."""

    @pytest.mark.asyncio
    async def test_delete_tag_not_found_service(self, db: AsyncSession):
        """Test deleting non-existent tag returns False."""
        service = TagService(db)
        result = await service.delete_tag(999)
        assert result is False


class TestTagListing:
    """Test tag listing and filtering."""

    @pytest.mark.asyncio
    async def test_list_tags_filters(self, tag_service: TagService, db: AsyncSession):
        """Test listing tags with various filters."""
        tag1 = Tag(name="Important", slug="important", post_count=1, is_important=True)
        tag2 = Tag(name="Normal", slug="normal", post_count=0, is_important=False)
        db.add_all([tag1, tag2])
        await db.commit()

        # include_empty=False
        tags = await tag_service.list_tags(include_empty=False)
        assert len(tags) == 1
        assert tags[0].name == "Important"

        # important_only=True
        tags = await tag_service.list_tags(important_only=True)
        assert len(tags) == 1
        assert tags[0].name == "Important"

        # search
        tags = await tag_service.list_tags(search="Norm")
        assert len(tags) == 1
        assert tags[0].name == "Normal"

    @pytest.mark.asyncio
    async def test_list_tags_search_service(self, db: AsyncSession):
        """Test listing tags with search."""
        service = TagService(db)
        await service.create_tag(TagCreate(name="Apple"))
        await service.create_tag(TagCreate(name="Banana"))

        tags = await service.list_tags(search="App", include_empty=True)
        assert len(tags) == 1
        assert tags[0].name == "Apple"

    @pytest.mark.asyncio
    async def test_get_important_and_featured_tags(self, tag_service: TagService, db: AsyncSession):
        """Test getting important and featured tags."""
        t1 = Tag(name="T1", slug="t1", post_count=1, is_important=True)
        t2 = Tag(name="T2", slug="t2", post_count=1, is_featured=True)
        db.add_all([t1, t2])
        await db.commit()

        important = await tag_service.get_important_tags()
        assert len(important) == 1
        assert important[0].name == "T1"

        featured = await tag_service.get_featured_tags()
        assert len(featured) == 1
        assert featured[0].name == "T2"


class TestPostCounts:
    """Test post count management."""

    @pytest.mark.asyncio
    async def test_update_all_post_counts(self, tag_service: TagService, db: AsyncSession):
        """Test recalculating post counts."""
        # Create tag and posts
        tag = Tag(name="Tag", slug="tag", post_count=0)
        p1 = Post(title="P1", slug="p1", content="C", status=PostStatus.PUBLISHED, author_id=1)
        p2 = Post(title="P2", slug="p2", content="C", status=PostStatus.DRAFT, author_id=1)
        p3 = Post(title="P3", slug="p3", content="C", status=PostStatus.PUBLISHED, author_id=1)

        p1.tags.append(tag)
        p2.tags.append(tag)
        p3.tags.append(tag)

        db.add_all([tag, p1, p2, p3])
        await db.commit()

        # Only published posts count
        await tag_service.update_all_post_counts()

        await db.refresh(tag)
        # Should be 2 (P1 and P3)
        assert tag.post_count == 2

    @pytest.mark.asyncio
    async def test_update_all_post_counts_orphaned_tags(self, tag_service: TagService, db: AsyncSession):
        """Test that tags with no posts get count 0."""
        tag = Tag(name="Orphan", slug="orphan", post_count=5)  # Incorrect count
        db.add(tag)
        await db.commit()

        await tag_service.update_all_post_counts()

        await db.refresh(tag)
        assert tag.post_count == 0
