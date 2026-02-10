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
    async def test_update_all_post_counts(self, tag_service: TagService, db: AsyncSession, test_user):
        """Test recalculating post counts."""
        user_id = test_user["user"].id
        # Create tag and posts
        tag = Tag(name="Tag", slug="tag", post_count=0)
        p1 = Post(title="P1", slug="p1", content="C", status=PostStatus.PUBLISHED, author_id=user_id)
        p2 = Post(title="P2", slug="p2", content="C", status=PostStatus.DRAFT, author_id=user_id)
        p3 = Post(title="P3", slug="p3", content="C", status=PostStatus.PUBLISHED, author_id=user_id)

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


class TestGetRelatedTags:
    """Test get_related_tags method."""

    @pytest.mark.asyncio
    async def test_get_related_tags_returns_tags_from_same_posts(
        self, tag_service: TagService, db: AsyncSession, test_user
    ):
        """Test that get_related_tags returns tags that appear on the same posts."""
        user_id = test_user["user"].id

        # Create tags with post_count > 0 so they're included in results
        tag1 = Tag(name="Photography", slug="photography", post_count=1)
        tag2 = Tag(name="Travel", slug="travel", post_count=1)
        tag3 = Tag(name="Nature", slug="nature", post_count=1)
        tag4 = Tag(name="Unrelated", slug="unrelated", post_count=1)

        db.add_all([tag1, tag2, tag3, tag4])
        await db.commit()

        # Create posts with overlapping tags
        post1 = Post(
            title="Post 1",
            slug="post-1",
            content="Content",
            status=PostStatus.PUBLISHED,
            author_id=user_id,
        )
        post1.tags.extend([tag1, tag2, tag3])  # tag1 appears with tag2 and tag3

        post2 = Post(
            title="Post 2",
            slug="post-2",
            content="Content",
            status=PostStatus.PUBLISHED,
            author_id=user_id,
        )
        post2.tags.extend([tag1, tag2])  # tag1 appears with tag2 again

        post3 = Post(
            title="Post 3",
            slug="post-3",
            content="Content",
            status=PostStatus.PUBLISHED,
            author_id=user_id,
        )
        post3.tags.append(tag4)  # tag4 doesn't appear with tag1

        db.add_all([post1, post2, post3])
        await db.commit()

        # Get related tags for tag1
        related = await tag_service.get_related_tags(tag1.id)

        # Should return tag2 and tag3, but not tag1 itself or tag4
        related_ids = {t.id for t in related}
        assert tag2.id in related_ids
        assert tag3.id in related_ids
        assert tag1.id not in related_ids  # Excludes self
        assert tag4.id not in related_ids  # Not related

    @pytest.mark.asyncio
    async def test_get_related_tags_excludes_specified_ids(
        self, tag_service: TagService, db: AsyncSession, test_user
    ):
        """Test that get_related_tags excludes specified tag IDs."""
        user_id = test_user["user"].id

        tag1 = Tag(name="Tag1", slug="tag1", post_count=1)
        tag2 = Tag(name="Tag2", slug="tag2", post_count=1)
        tag3 = Tag(name="Tag3", slug="tag3", post_count=1)

        db.add_all([tag1, tag2, tag3])
        await db.commit()

        post = Post(
            title="Post",
            slug="post-related",
            content="Content",
            status=PostStatus.PUBLISHED,
            author_id=user_id,
        )
        post.tags.extend([tag1, tag2, tag3])
        db.add(post)
        await db.commit()

        # Get related tags for tag1, excluding tag2
        related = await tag_service.get_related_tags(tag1.id, exclude_ids={tag2.id})

        related_ids = {t.id for t in related}
        assert tag3.id in related_ids
        assert tag2.id not in related_ids  # Excluded
        assert tag1.id not in related_ids  # Self always excluded

    @pytest.mark.asyncio
    async def test_get_related_tags_filters_empty_tags(
        self, tag_service: TagService, db: AsyncSession, test_user
    ):
        """Test that get_related_tags only returns tags with post_count > 0."""
        user_id = test_user["user"].id

        tag1 = Tag(name="Tag1", slug="tag1-empty", post_count=1)
        tag2 = Tag(name="Tag2", slug="tag2-empty", post_count=0)  # Empty tag

        db.add_all([tag1, tag2])
        await db.commit()

        post = Post(
            title="Post",
            slug="post-empty-tags",
            content="Content",
            status=PostStatus.PUBLISHED,
            author_id=user_id,
        )
        post.tags.extend([tag1, tag2])
        db.add(post)
        await db.commit()

        # Get related tags for tag1
        related = await tag_service.get_related_tags(tag1.id)

        # Should not include tag2 because it has post_count=0
        related_ids = {t.id for t in related}
        assert tag2.id not in related_ids

    @pytest.mark.asyncio
    async def test_get_related_tags_returns_empty_list_when_no_related_tags(
        self, tag_service: TagService, db: AsyncSession, test_user
    ):
        """Test that get_related_tags returns empty list when there are no related tags."""
        user_id = test_user["user"].id

        tag = Tag(name="Lonely", slug="lonely", post_count=0)
        db.add(tag)
        await db.commit()

        post = Post(
            title="Post",
            slug="post-lonely",
            content="Content",
            status=PostStatus.PUBLISHED,
            author_id=user_id,
        )
        post.tags.append(tag)
        db.add(post)
        await db.commit()

        related = await tag_service.get_related_tags(tag.id)
        assert len(related) == 0

    @pytest.mark.asyncio
    async def test_get_related_tags_orders_by_name(
        self, tag_service: TagService, db: AsyncSession, test_user
    ):
        """Test that get_related_tags returns results ordered by name."""
        user_id = test_user["user"].id

        tag1 = Tag(name="Main", slug="main", post_count=1)
        tag2 = Tag(name="Zebra", slug="zebra", post_count=1)
        tag3 = Tag(name="Apple", slug="apple", post_count=1)
        tag4 = Tag(name="Mango", slug="mango", post_count=1)

        db.add_all([tag1, tag2, tag3, tag4])
        await db.commit()

        post = Post(
            title="Post",
            slug="post-ordered",
            content="Content",
            status=PostStatus.PUBLISHED,
            author_id=user_id,
        )
        post.tags.extend([tag1, tag2, tag3, tag4])
        db.add(post)
        await db.commit()

        related = await tag_service.get_related_tags(tag1.id)

        # Should be ordered alphabetically by name
        assert related[0].name == "Apple"
        assert related[1].name == "Mango"
        assert related[2].name == "Zebra"
