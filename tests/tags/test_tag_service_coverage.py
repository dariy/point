
import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from app.services.tag_service import TagService
from app.schemas.tag import TagCreate, TagUpdate
from app.models.tag import Tag
from app.models.post import Post, PostStatus

@pytest.mark.asyncio
async def test_update_tag_not_found_service(db: AsyncSession):
    """Test updating a non-existent tag returns None."""
    service = TagService(db)
    result = await service.update_tag(999, TagUpdate(name="New"))
    assert result is None

@pytest.mark.asyncio
async def test_update_tag_name_conflict_explicit(db: AsyncSession):
    """Test updating tag name to existing one raises ValueError."""
    service = TagService(db)
    t1 = await service.create_tag(TagCreate(name="Tag1"))
    t2 = await service.create_tag(TagCreate(name="Tag2"))
    
    with pytest.raises(ValueError):
        await service.update_tag(t1.id, TagUpdate(name="Tag2"))

@pytest.mark.asyncio
async def test_update_tag_slug_conflict_explicit(db: AsyncSession):
    """Test updating tag slug to existing one raises ValueError."""
    service = TagService(db)
    t1 = await service.create_tag(TagCreate(name="Tag1"))
    t2 = await service.create_tag(TagCreate(name="Tag2"))
    
    with pytest.raises(ValueError):
        await service.update_tag(t1.id, TagUpdate(slug=t2.slug))

@pytest.mark.asyncio
async def test_delete_tag_not_found_service(db: AsyncSession):
    """Test deleting non-existent tag returns False."""
    service = TagService(db)
    result = await service.delete_tag(999)
    assert result is False

@pytest.mark.asyncio
async def test_list_tags_search_service(db: AsyncSession):
    """Test listing tags with search."""
    service = TagService(db)
    await service.create_tag(TagCreate(name="Apple"))
    await service.create_tag(TagCreate(name="Banana"))
    
    tags = await service.list_tags(search="App", include_empty=True)
    assert len(tags) == 1
    assert tags[0].name == "Apple"

@pytest.mark.asyncio
async def test_tag_cloud_single_tag(db: AsyncSession):
    """Test tag cloud weight calculation with single tag."""
    service = TagService(db)
    t1 = await service.create_tag(TagCreate(name="Tag1", is_featured=True))
    t1.post_count = 5
    db.add(t1)
    await db.commit()
    
    cloud = await service.get_tag_cloud(featured=True)
    assert len(cloud) == 1
    assert cloud[0]["weight"] == 0.0 # (5-5)/1 = 0? Wait, formula: (tag.post_count - min_count) / count_range
    # min=5, max=5, range=0 or 1.
    # range = 5-5 or 1 = 0 or 1 = 1?
    # Code: count_range = max_count - min_count or 1
    # 5-5 = 0. So count_range = 1.
    # weight = (5-5)/1 = 0.

@pytest.mark.asyncio
async def test_add_tags_empty_string(db: AsyncSession):
    """Test adding tags with empty strings ignored."""
    service = TagService(db)
    user_id = 1 # Dummy
    post = Post(title="T", slug="t", content="c", status=PostStatus.DRAFT, author_id=user_id)
    db.add(post)
    await db.commit()
    await db.refresh(post, attribute_names=["tags"])
    
    tags = await service.add_tags_to_post(post, ["Valid", "  ", ""])
    assert len(tags) == 1
    assert tags[0].name == "Valid"

@pytest.mark.asyncio
async def test_remove_tags_updates_counts(db: AsyncSession):
    """Test that removing tags updates their post counts."""
    service = TagService(db)
    user_id = 1
    post = Post(title="T", slug="t", content="c", status=PostStatus.PUBLISHED, author_id=user_id)
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
