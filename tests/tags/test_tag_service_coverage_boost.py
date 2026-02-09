"""Additional tests to boost tag service coverage to 90%."""

from unittest.mock import patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostFormatter, PostStatus
from app.schemas.tag import TagCreate, TagUpdate
from app.services.tag_service import TagService


@pytest.fixture
def tag_service(db: AsyncSession):
    """Create tag service instance."""
    return TagService(db)


class TestTagUpdateAdvanced:
    """Advanced tag update scenarios."""

    @pytest.mark.asyncio
    async def test_update_tag_name_auto_generates_slug(
        self, tag_service: TagService, db: AsyncSession
    ):
        """Test updating tag name auto-generates new slug."""
        tag = await tag_service.create_tag(TagCreate(name="Original Name"))
        await db.commit()

        # Update name without providing slug
        updated = await tag_service.update_tag(tag.id, TagUpdate(name="New Name"))
        assert updated.name == "New Name"
        assert updated.slug == "new-name"

    @pytest.mark.asyncio
    async def test_update_tag_explicit_slug(
        self, tag_service: TagService, db: AsyncSession
    ):
        """Test updating tag with explicit slug."""
        tag = await tag_service.create_tag(TagCreate(name="Test Tag"))
        await db.commit()

        # Update with explicit slug
        updated = await tag_service.update_tag(tag.id, TagUpdate(slug="custom-slug"))
        assert updated.slug == "custom-slug"

    @pytest.mark.asyncio
    async def test_update_tag_all_fields(
        self, tag_service: TagService, db: AsyncSession
    ):
        """Test updating all tag fields."""
        tag = await tag_service.create_tag(TagCreate(name="Test"))
        await db.commit()

        updated = await tag_service.update_tag(
            tag.id,
            TagUpdate(
                description="New description",
                custom_url="https://example.com",
                is_important=True,
                is_featured=True,
            ),
        )

        assert updated.description == "New description"
        assert updated.custom_url == "https://example.com"
        assert updated.is_important is True
        assert updated.is_featured is True

    @pytest.mark.asyncio
    async def test_update_tag_cache_invalidation_error(
        self, tag_service: TagService, db: AsyncSession
    ):
        """Test that cache invalidation errors don't break update."""
        tag = await tag_service.create_tag(TagCreate(name="Test"))
        await db.commit()

        with patch("app.services.tag_service.invalidate_cache_for_tag") as mock_cache:
            mock_cache.side_effect = Exception("Cache error")

            # Should still update successfully despite cache error
            updated = await tag_service.update_tag(tag.id, TagUpdate(name="Updated"))
            assert updated.name == "Updated"


class TestTagDeleteAdvanced:
    """Advanced tag deletion scenarios."""

    @pytest.mark.asyncio
    async def test_delete_tag_cache_invalidation_error(
        self, tag_service: TagService, db: AsyncSession
    ):
        """Test that cache invalidation errors don't break deletion."""
        tag = await tag_service.create_tag(TagCreate(name="Delete Me"))
        await db.commit()
        tag_id = tag.id

        with patch("app.services.tag_service.invalidate_cache_for_tag") as mock_cache:
            mock_cache.side_effect = Exception("Cache error")

            # Should still delete successfully despite cache error
            result = await tag_service.delete_tag(tag_id)
            assert result is True


class TestTagListingAdvanced:
    """Advanced tag listing scenarios."""

    @pytest.mark.asyncio
    async def test_list_tags_desc_sort(self, tag_service: TagService, db: AsyncSession):
        """Test listing tags with descending sort."""
        await tag_service.create_tag(TagCreate(name="Alpha"))
        await tag_service.create_tag(TagCreate(name="Beta"))
        await tag_service.create_tag(TagCreate(name="Gamma"))
        await db.commit()

        tags = await tag_service.list_tags(sort_by="name", sort_order="desc")
        assert len(tags) == 3
        assert tags[0].name == "Gamma"
        assert tags[1].name == "Beta"
        assert tags[2].name == "Alpha"

    @pytest.mark.asyncio
    async def test_list_tags_sort_by_post_count(
        self, tag_service: TagService, db: AsyncSession
    ):
        """Test listing tags sorted by post count with secondary sort by name."""
        t1 = await tag_service.create_tag(TagCreate(name="Zeta"))
        t1.post_count = 5
        t2 = await tag_service.create_tag(TagCreate(name="Alpha"))
        t2.post_count = 10
        t3 = await tag_service.create_tag(TagCreate(name="Beta"))
        t3.post_count = 10
        db.add_all([t1, t2, t3])
        await db.commit()

        tags = await tag_service.list_tags(sort_by="post_count", sort_order="desc")
        # Should be sorted by post_count desc, then name asc
        assert tags[0].name == "Alpha"  # post_count=10, name=Alpha
        assert tags[1].name == "Beta"  # post_count=10, name=Beta
        assert tags[2].name == "Zeta"  # post_count=5


class TestTagCloudAdvanced:
    """Advanced tag cloud scenarios."""

    @pytest.mark.asyncio
    async def test_tag_cloud_without_featured_filter(
        self, tag_service: TagService, db: AsyncSession
    ):
        """Test tag cloud without featured filter."""
        t1 = await tag_service.create_tag(
            TagCreate(name="Regular Tag", is_featured=False)
        )
        t1.post_count = 5
        db.add(t1)
        await db.commit()

        cloud = await tag_service.get_tag_cloud(featured=False)
        assert len(cloud) == 1
        assert cloud[0]["name"] == "Regular Tag"


class TestPostCountUpdates:
    """Test post count update scenarios."""

    @pytest.mark.asyncio
    async def test_update_post_count_tag_not_found(self, tag_service: TagService):
        """Test update_post_count when tag doesn't exist."""
        # Should not raise an error
        await tag_service.update_post_count(999)


class TestGetPostsByTag:
    """Test get_posts_by_tag scenarios."""

    @pytest.mark.asyncio
    async def test_get_posts_by_tag_include_drafts(
        self, tag_service: TagService, db: AsyncSession
    ):
        """Test getting posts by tag including drafts."""
        tag = await tag_service.create_tag(TagCreate(name="Test Tag"))
        await db.commit()

        # Create published and draft posts
        p1 = Post(
            title="Published",
            slug="published",
            content="c",
            status=PostStatus.PUBLISHED,
            formatter=PostFormatter.MARKDOWN,
            author_id=1,
        )
        p2 = Post(
            title="Draft",
            slug="draft",
            content="c",
            status=PostStatus.DRAFT,
            formatter=PostFormatter.MARKDOWN,
            author_id=1,
        )
        p1.tags.append(tag)
        p2.tags.append(tag)
        db.add_all([p1, p2])
        await db.commit()

        # Get all posts (including drafts)
        posts, total = await tag_service.get_posts_by_tag(tag.id, published_only=False)
        assert total == 2
        assert len(posts) == 2

        # Get only published
        posts, total = await tag_service.get_posts_by_tag(tag.id, published_only=True)
        assert total == 1
        assert len(posts) == 1

    @pytest.mark.asyncio
    async def test_get_posts_by_tag_pagination_offset(
        self, tag_service: TagService, db: AsyncSession
    ):
        """Test get_posts_by_tag with pagination offset."""
        tag = await tag_service.create_tag(TagCreate(name="Test"))
        await db.commit()

        # Create multiple posts
        for i in range(5):
            post = Post(
                title=f"Post {i}",
                slug=f"post-{i}",
                content="c",
                status=PostStatus.PUBLISHED,
                formatter=PostFormatter.MARKDOWN,
                author_id=1,
            )
            post.tags.append(tag)
            db.add(post)
        await db.commit()

        # Get page 2
        posts, total = await tag_service.get_posts_by_tag(tag.id, page=2, per_page=2)
        assert total == 5
        assert len(posts) == 2


class TestAddTagsToPost:
    """Test add_tags_to_post scenarios."""

    @pytest.mark.asyncio
    async def test_add_tags_to_post_skip_duplicates(
        self, tag_service: TagService, db: AsyncSession
    ):
        """Test adding tags skips duplicates."""
        post = Post(
            title="P", slug="p", content="C", status=PostStatus.PUBLISHED, author_id=1
        )
        db.add(post)
        await db.commit()
        await db.refresh(post, ["tags"])

        # Add tags first time
        tags1 = await tag_service.add_tags_to_post(post, ["Tag1", "Tag2"])
        assert len(tags1) == 2

        # Add same tags again (should skip duplicates)
        await tag_service.add_tags_to_post(post, ["Tag1", "Tag2"])
        await db.refresh(post, ["tags"])
        assert len(post.tags) == 2  # Still only 2 tags


class TestSetPostTags:
    """Test set_post_tags scenarios."""

    @pytest.mark.asyncio
    async def test_set_post_tags_updates_removed_tag_counts(
        self, tag_service: TagService, db: AsyncSession
    ):
        """Test that set_post_tags updates counts for removed tags."""
        post = Post(
            title="P", slug="p", content="C", status=PostStatus.PUBLISHED, author_id=1
        )
        db.add(post)
        await db.commit()
        await db.refresh(post, ["tags"])

        # Set initial tags
        await tag_service.set_post_tags(post, ["Tag1", "Tag2", "Tag3"])
        await db.commit()

        # Get the tags
        tag1 = await tag_service.get_tag_by_name("Tag1")
        tag2 = await tag_service.get_tag_by_name("Tag2")
        tag3 = await tag_service.get_tag_by_name("Tag3")

        assert tag1.post_count == 1
        assert tag2.post_count == 1
        assert tag3.post_count == 1

        # Replace with different tags (removing Tag2 and Tag3)
        await tag_service.set_post_tags(post, ["Tag1", "Tag4"])
        await db.commit()

        # Refresh tags to get updated counts
        await db.refresh(tag1)
        await db.refresh(tag2)
        await db.refresh(tag3)

        assert tag1.post_count == 1  # Still attached
        assert tag2.post_count == 0  # Removed
        assert tag3.post_count == 0  # Removed
