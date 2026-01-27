import pytest
from unittest.mock import patch
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.post import Post, PostStatus, PostFormatter
from app.services.post_service import PostService, _view_counts_buffer

@pytest.fixture
async def sample_post(db: AsyncSession, test_user: dict) -> Post:
    """Create a sample post in the database."""
    post = Post(
        title="Sample Post",
        slug="sample-post",
        content="This is sample content.",
        excerpt="Sample excerpt",
        formatter=PostFormatter.RAW,
        status=PostStatus.DRAFT,
        author_id=test_user["user"].id,
    )
    db.add(post)
    await db.commit()
    await db.refresh(post)
    return post

@pytest.mark.asyncio
async def test_view_count_buffering(db, sample_post):
    service = PostService(db)
    
    # Ensure buffer is empty
    _view_counts_buffer.clear()
    
    # Increment view count
    await service.increment_view_count(sample_post.id)
    
    # Check buffer
    assert _view_counts_buffer[sample_post.id] == 1
    
    # Increment again
    await service.increment_view_count(sample_post.id)
    assert _view_counts_buffer[sample_post.id] == 2
    
    # Verify DB not updated yet
    await db.refresh(sample_post)
    assert sample_post.view_count == 0

@pytest.mark.asyncio
async def test_flush_view_counts(db, sample_post):
    service = PostService(db)
    _view_counts_buffer.clear()
    
    # Set buffer directly
    _view_counts_buffer[sample_post.id] = 5
    
    # Flush
    count = await PostService.flush_view_counts(db)
    assert count == 1
    
    # Verify DB updated
    result = await db.execute(select(Post).where(Post.id == sample_post.id))
    updated_post = result.scalar_one()
    assert updated_post.view_count == 5
    
    # Verify buffer cleared
    assert len(_view_counts_buffer) == 0

@pytest.mark.asyncio
async def test_flush_empty_buffer(db):
    _view_counts_buffer.clear()
    count = await PostService.flush_view_counts(db)
    assert count == 0