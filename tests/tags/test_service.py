"""Additional tests for TagService coverage."""

from sqlalchemy.ext.asyncio import AsyncSession
from unittest.mock import AsyncMock, MagicMock
import pytest

from app.models.post import Post, PostStatus
from app.models.tag import Tag
from app.schemas.tag import TagCreate, TagUpdate
from app.services.tag_service import TagService


@pytest.fixture
def tag_service(db: AsyncSession):
    return TagService(db)

@pytest.mark.asyncio
async def test_create_tag_duplicate_name(tag_service: TagService, db: AsyncSession):
    """Test creating tag with duplicate name raises ValueError."""




    tag1 = Tag(name="Tag 1", slug="tag-1", post_count=0)
    db.add(tag1)
    await db.commit()
    
    # Create tag with same name
    tag_data = TagCreate(name="Tag 1")
    with pytest.raises(ValueError):
        await tag_service.create_tag(tag_data)

@pytest.mark.asyncio
async def test_set_post_tags_create_new(tag_service: TagService, db: AsyncSession):
    """Test setting post tags creates new tags."""
    post = Post(title="P", slug="p", content="C", author_id=1)
    db.add(post)
    await db.commit()
    await db.refresh(post, ["tags"]) # Load tags
    
    tags = await tag_service.set_post_tags(post, ["New Tag 1", "New Tag 2"])
    
    assert len(tags) == 2
    assert {t.name for t in tags} == {"New Tag 1", "New Tag 2"}

@pytest.mark.asyncio
async def test_set_post_tags_existing(tag_service: TagService, db: AsyncSession):
    """Test setting post tags uses existing tags."""
    tag1 = Tag(name="Existing", slug="existing", post_count=0)
    db.add(tag1)
    await db.commit()
    
    post = Post(title="P", slug="p", content="C", author_id=1)
    db.add(post)
    await db.commit()
    await db.refresh(post, ["tags"]) # Load tags
    
    tags = await tag_service.set_post_tags(post, ["Existing", "New"])
    
    assert len(tags) == 2
    tag_names = {t.name for t in tags}
    assert "Existing" in tag_names
    assert "New" in tag_names

@pytest.mark.asyncio
async def test_update_all_post_counts(tag_service: TagService, db: AsyncSession):
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
async def test_update_all_post_counts_orphaned_tags(tag_service: TagService, db: AsyncSession):
    """Test that tags with no posts get count 0."""
    tag = Tag(name="Orphan", slug="orphan", post_count=5) # Incorrect count
    db.add(tag)
    await db.commit()
    
    await tag_service.update_all_post_counts()
    
    await db.refresh(tag)
    assert tag.post_count == 0

@pytest.mark.asyncio
async def test_update_tag_conflict(tag_service: TagService, db: AsyncSession):
    """Test updating tag name to an existing one raises ValueError."""
    tag1 = Tag(name="Tag 1", slug="tag-1", post_count=0)
    tag2 = Tag(name="Tag 2", slug="tag-2", post_count=0)
    db.add_all([tag1, tag2])
    await db.commit()
    
    with pytest.raises(ValueError):
        await tag_service.update_tag(tag1.id, TagUpdate(name="Tag 2"))

@pytest.mark.asyncio
async def test_update_tag_slug_conflict(tag_service: TagService, db: AsyncSession):
    """Test updating tag slug to an existing one raises ValueError."""
    tag1 = Tag(name="Tag 1", slug="tag-1", post_count=0)
    tag2 = Tag(name="Tag 2", slug="tag-2", post_count=0)
    db.add_all([tag1, tag2])
    await db.commit()
    
    with pytest.raises(ValueError):
        await tag_service.update_tag(tag1.id, TagUpdate(slug="tag-2"))

@pytest.mark.asyncio
async def test_list_tags_filters(tag_service: TagService, db: AsyncSession):
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
async def test_get_important_and_featured_tags(tag_service: TagService, db: AsyncSession):
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

@pytest.mark.asyncio
async def test_remove_tags_from_post(tag_service: TagService, db: AsyncSession):
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




