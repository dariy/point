
import pytest
from unittest.mock import patch, MagicMock
from sqlalchemy.ext.asyncio import AsyncSession
from app.services.post_service import PostService, _view_counts_buffer
from app.models.post import Post, PostStatus
from app.models.user import User
from app.schemas.post import PostCreate, PostUpdate, PostFormatter

@pytest.mark.asyncio
async def test_list_posts_by_author(db: AsyncSession):
    """Test listing posts filtered by author."""
    service = PostService(db)
    # Assume users 1 and 2 exist (or create them if using real DB)
    # Using dummy IDs for filtering check
    
    # Create posts
    p1 = Post(title="P1", slug="p1", content="c", author_id=1, status=PostStatus.PUBLISHED)
    p2 = Post(title="P2", slug="p2", content="c", author_id=2, status=PostStatus.PUBLISHED)
    db.add_all([p1, p2])
    await db.commit()
    
    posts, _ = await service.list_posts(author_id=1)
    assert len(posts) == 1
    assert posts[0].title == "P1"

@pytest.mark.asyncio
async def test_update_post_enum_conversion(db: AsyncSession):
    """Test updating post with Enum value triggers value conversion."""
    service = PostService(db)
    post = Post(title="P", slug="p", content="c", author_id=1, status=PostStatus.DRAFT)
    db.add(post)
    await db.commit()
    
    # Update with Enum
    await service.update_post(post.id, PostUpdate(status=PostStatus.PUBLISHED))
    await db.refresh(post)
    assert post.status == PostStatus.PUBLISHED.value # Should be string value

@pytest.mark.asyncio
async def test_update_post_sets_published_at(db: AsyncSession):
    """Test setting status to PUBLISHED sets published_at."""
    service = PostService(db)
    post = Post(title="P", slug="p", content="c", author_id=1, status=PostStatus.DRAFT, published_at=None)
    db.add(post)
    await db.commit()
    
    await service.update_post(post.id, PostUpdate(status=PostStatus.PUBLISHED))
    await db.refresh(post)
    assert post.published_at is not None

@pytest.mark.asyncio
async def test_update_post_regenerates_excerpt(db: AsyncSession):
    """Test updating content regenerates excerpt if not provided."""
    service = PostService(db)
    post = Post(title="P", slug="p", content="Old content", excerpt="Old excerpt", author_id=1, status=PostStatus.DRAFT)
    db.add(post)
    await db.commit()
    
    # Update content, no excerpt
    await service.update_post(post.id, PostUpdate(content="New content starts here. And continues."))
    await db.refresh(post)
    assert "New content" in post.excerpt

@pytest.mark.asyncio
async def test_delete_post_author_mismatch(db: AsyncSession):
    """Test delete post fails if author_id mismatches."""
    service = PostService(db)
    post = Post(title="P", slug="p", content="c", author_id=1, status=PostStatus.DRAFT)
    db.add(post)
    await db.commit()
    
    success = await service.delete_post(post.id, author_id=2)
    assert success is False
    
    # Verify not deleted
    p = await service.get_post_by_id(post.id, include_hidden=True)
    assert p is not None

@pytest.mark.asyncio
async def test_cache_invalidation_exceptions(db: AsyncSession):
    """Test cache invalidation exceptions are caught and logged."""
    service = PostService(db)
    post = Post(title="P", slug="p", content="c", author_id=1, status=PostStatus.PUBLISHED)
    db.add(post)
    await db.commit()
    
    with patch("app.services.post_service.invalidate_cache_for_post", side_effect=Exception("Cache error")):
        # Update
        await service.update_post(post.id, PostUpdate(title="New Title"))
        # Delete
        await service.delete_post(post.id)
        # Should not raise

@pytest.mark.asyncio
async def test_flush_view_counts_exception(db: AsyncSession):
    """Test exception during flush restores buffer."""
    service = PostService(db)
    _view_counts_buffer.clear()
    _view_counts_buffer[1] = 5
    
    # Mock db.execute to raise
    original_execute = db.execute
    db.execute = MagicMock(side_effect=Exception("DB Error"))
    
    count = await service.flush_view_counts(db)
    assert count == 0
    assert _view_counts_buffer[1] == 5 # Restored
    
    # Restore db
    db.execute = original_execute
    _view_counts_buffer.clear()

@pytest.mark.asyncio
async def test_update_post_with_tags_not_found(db: AsyncSession):
    """Test updating non-existent post with tags returns None."""
    service = PostService(db)
    # Mock TagService
    tag_service = MagicMock()
    
    result = await service.update_post_with_tags(999, PostUpdate(title="T"), tag_service)
    assert result is None
