"""Tests for hierarchical tag relationships (meta-tags)."""

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.tag import tag_relationships
from app.schemas.tag import TagCreate, TagUpdate
from app.services.tag_service import TagService


@pytest.fixture
def tag_service(db: AsyncSession):
    """Create tag service instance."""
    return TagService(db)


@pytest.mark.asyncio
class TestTagHierarchy:
    """Test hierarchical tag operations."""

    async def test_create_tag_with_parents(self, tag_service: TagService, db: AsyncSession):
        """Test creating a tag with parent relationships."""
        # Create parent tags first
        p1 = await tag_service.create_tag(TagCreate(name="Category A"))
        p2 = await tag_service.create_tag(TagCreate(name="Category B"))

        # Create child tag
        child = await tag_service.create_tag(
            TagCreate(name="Subtag", parent_ids=[p1.id, p2.id])
        )

        assert child.name == "Subtag"
        assert len(child.parents) == 2
        parent_names = {p.name for p in child.parents}
        assert "Category A" in parent_names
        assert "Category B" in parent_names

        # Verify from parent side
        await db.refresh(p1, ["children"])
        assert len(p1.children) == 1
        assert p1.children[0].id == child.id

    async def test_update_tag_parents(self, tag_service: TagService, db: AsyncSession):
        """Test updating a tag's parent relationships."""
        p1 = await tag_service.create_tag(TagCreate(name="Parent 1"))
        p2 = await tag_service.create_tag(TagCreate(name="Parent 2"))
        child = await tag_service.create_tag(TagCreate(name="Child", parent_ids=[p1.id]))

        assert len(child.parents) == 1

        # Update parents: remove p1, add p2
        await tag_service.update_tag(child.id, TagUpdate(parent_ids=[p2.id]))
        await db.refresh(child, ["parents"])

        assert len(child.parents) == 1
        assert child.parents[0].id == p2.id

        # Update parents: empty list
        await tag_service.update_tag(child.id, TagUpdate(parent_ids=[]))
        await db.refresh(child, ["parents"])
        assert len(child.parents) == 0

    async def test_get_hierarchical_tags(self, tag_service: TagService):
        """Test retrieving tags grouped by parents."""
        p1 = await tag_service.create_tag(TagCreate(name="Alpha"))
        p2 = await tag_service.create_tag(TagCreate(name="Beta"))
        await tag_service.create_tag(TagCreate(name="A1", parent_ids=[p1.id]))
        await tag_service.create_tag(TagCreate(name="A2", parent_ids=[p1.id]))
        await tag_service.create_tag(TagCreate(name="B1", parent_ids=[p2.id]))
        await tag_service.create_tag(TagCreate(name="Solo"))

        hierarchy = await tag_service.get_hierarchical_tags()

        # Should have Alpha, Beta (with children) and Solo (no children, as a top-level tag)
        # Note: get_hierarchical_tags returns top-level tags and their children.
        # Let's verify the structure.
        assert len(hierarchy) >= 3

        alpha_group = next((g for g in hierarchy if g["tag"].name == "Alpha"), None)
        assert alpha_group is not None
        assert len(alpha_group["children"]) == 2

        beta_group = next((g for g in hierarchy if g["tag"].name == "Beta"), None)
        assert beta_group is not None
        assert len(beta_group["children"]) == 1

    async def test_list_tags_with_parent_filter(self, tag_service: TagService):
        """Test filtering tags by parent_id."""
        p = await tag_service.create_tag(TagCreate(name="Parent"))
        await tag_service.create_tag(TagCreate(name="C1", parent_ids=[p.id]))
        await tag_service.create_tag(TagCreate(name="C2", parent_ids=[p.id]))
        await tag_service.create_tag(TagCreate(name="Other"))

        # Filter by parent
        children = await tag_service.list_tags(parent_id=p.id)
        assert len(children) == 2
        assert {c.name for c in children} == {"C1", "C2"}

    async def test_delete_tag_cascade(self, tag_service: TagService, db: AsyncSession):
        """Test that deleting a tag removes its relationships (CASCADE)."""
        p = await tag_service.create_tag(TagCreate(name="Parent"))
        c = await tag_service.create_tag(TagCreate(name="Child", parent_ids=[p.id]))

        # Verify relationship exists in junction table
        result = await db.execute(
            select(tag_relationships).where(
                tag_relationships.c.parent_id == p.id,
                tag_relationships.c.child_id == c.id
            )
        )
        assert result.first() is not None

        # Delete parent
        await tag_service.delete_tag(p.id)
        await db.flush()

        # Explicitly reload parents of the child object
        await db.refresh(c, ["parents"])
        assert len(c.parents) == 0
