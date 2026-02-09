"""Final tests to achieve 100% tag service coverage."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.tag import TagCreate, TagUpdate
from app.services.tag_service import TagService


@pytest.fixture
def tag_service(db: AsyncSession):
    """Create tag service instance."""
    return TagService(db)


class TestTagServiceEdgeCases:
    """Edge case tests for complete coverage."""

    @pytest.mark.asyncio
    async def test_update_tag_name_with_explicit_slug(
        self, tag_service: TagService, db: AsyncSession
    ):
        """Test updating tag name with explicit slug provided (skips auto-generation)."""
        tag = await tag_service.create_tag(TagCreate(name="Original"))
        await db.commit()

        # Update both name and slug explicitly
        updated = await tag_service.update_tag(
            tag.id, TagUpdate(name="New Name", slug="explicit-slug")
        )
        assert updated.name == "New Name"
        assert updated.slug == "explicit-slug"  # Uses explicit slug, not auto-generated

    @pytest.mark.asyncio
    async def test_get_tag_cloud_empty_database(self, tag_service: TagService):
        """Test tag cloud returns empty list when no tags exist."""
        cloud = await tag_service.get_tag_cloud()
        assert cloud == []

    @pytest.mark.asyncio
    async def test_get_tag_cloud_no_posts(
        self, tag_service: TagService, db: AsyncSession
    ):
        """Test tag cloud returns empty when tags have no posts."""
        # Create tags with 0 posts
        await tag_service.create_tag(TagCreate(name="Tag1", is_featured=True))
        await tag_service.create_tag(TagCreate(name="Tag2", is_featured=True))
        await db.commit()

        # Both tags have post_count = 0, so cloud should be empty
        cloud = await tag_service.get_tag_cloud()
        assert cloud == []
