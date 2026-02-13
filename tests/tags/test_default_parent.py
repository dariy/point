"""Tests for default parent tag functionality."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.tag import TagCreate
from app.services.tag_service import TagService


@pytest.mark.asyncio
async def test_create_tag_default_parent(db: AsyncSession, service: TagService) -> None:
    """Test that newly created tags have 'other' as default parent."""
    # Create a tag without specifying parents
    tag = await service.create_tag(TagCreate(name="New Tag"))

    # Check if 'other' tag was created and assigned as parent
    assert len(tag.parents) == 1
    assert tag.parents[0].name == "other"

    # Create another tag, it should also have 'other' as parent
    tag2 = await service.create_tag(TagCreate(name="Another Tag"))
    assert len(tag2.parents) == 1
    assert tag2.parents[0].name == "other"
    assert tag2.parents[0].id == tag.parents[0].id


@pytest.mark.asyncio
async def test_create_tag_with_explicit_parent(db: AsyncSession, service: TagService) -> None:
    """Test that explicit parents override the default 'other' parent."""
    # Create a parent tag
    parent = await service.create_tag(TagCreate(name="Manual Parent"))

    # Create a tag with explicit parent
    tag = await service.create_tag(TagCreate(name="Child Tag", parent_ids=[parent.id]))

    # Check that only the explicit parent is assigned
    assert len(tag.parents) == 1
    assert tag.parents[0].id == parent.id
    assert tag.parents[0].name == "Manual Parent"


@pytest.mark.asyncio
async def test_create_other_tag_itself(db: AsyncSession, service: TagService) -> None:
    """Test that creating the 'other' tag itself doesn't cause issues."""
    tag = await service.create_tag(TagCreate(name="other"))

    # It should not have any parents
    assert len(tag.parents) == 0
    assert tag.name == "other"
