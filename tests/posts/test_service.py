"""Additional tests for PostService coverage."""

from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from app.models.post import Post, PostFormatter, PostStatus
from app.schemas.post import PostCreate, PostUpdate
from app.services.post_service import PostService, _view_counts_buffer


@pytest.fixture
def post_service(db: AsyncSession):
    return PostService(db)

@pytest.mark.asyncio
async def test_flush_view_counts_empty(db: AsyncSession):
    """Test flushing view counts when buffer is empty."""




    _view_counts_buffer.clear()
    count = await PostService.flush_view_counts(db)
    assert count == 0

@pytest.mark.asyncio
async def test_flush_view_counts_exception(db: AsyncSession):
    """Test exception handling during view count flush."""
    _view_counts_buffer.clear()
    _view_counts_buffer[1] = 5
    
    # Mock db.execute to raise exception
    db.execute = AsyncMock(side_effect=Exception("DB Error"))
    
    count = await PostService.flush_view_counts(db)
    assert count == 0
    # Buffer should be restored
    assert _view_counts_buffer[1] == 5
    _view_counts_buffer.clear()

@pytest.mark.asyncio
async def test_get_existing_slugs_exclude_id(post_service: PostService, db: AsyncSession):
    """Test getting existing slugs excluding a specific ID."""
    # Create two posts
    post1 = Post(title="Post 1", slug="post-1", content="Content", author_id=1)
    post2 = Post(title="Post 2", slug="post-2", content="Content", author_id=1)
    db.add_all([post1, post2])
    await db.commit()
    
    slugs = await post_service._get_existing_slugs(exclude_id=post1.id)
    assert "post-1" not in slugs
    assert "post-2" in slugs

@pytest.mark.asyncio
async def test_create_post_with_excerpt(post_service: PostService):
    """Test creating post with provided excerpt."""
    post_data = PostCreate(
        title="Title",
        content="Content",
        excerpt="Custom Excerpt"
    )
    post = await post_service.create_post(post_data, author_id=1)
    assert post.excerpt == "Custom Excerpt"

@pytest.mark.asyncio
async def test_get_post_by_slug_include_drafts(post_service: PostService, db: AsyncSession):
    """Test getting post by slug including drafts."""
    post = Post(
        title="Draft", 
        slug="draft", 
        content="Content", 
        status=PostStatus.DRAFT, 
        author_id=1
    )
    db.add(post)
    await db.commit()
    
    # Should not find it by default
    found = await post_service.get_post_by_slug("draft")
    assert found is None
    
    # Should find it with include_drafts
    found = await post_service.get_post_by_slug("draft", include_drafts=True)
    assert found is not None
    assert found.id == post.id

@pytest.mark.asyncio
async def test_get_post_by_preview_token_invalid(post_service: PostService, db: AsyncSession):
    """Test getting post by invalid or expired preview token."""
    post = Post(
        title="Draft", 
        slug="draft", 
        content="Content", 
        status=PostStatus.DRAFT, 
        author_id=1,
        preview_token="token",
        preview_expires_at=datetime.utcnow() - timedelta(hours=1)
    )
    db.add(post)
    await db.commit()
    
    # Expired token
    found = await post_service.get_post_by_preview_token("token")
    assert found is None
    
    # Non-existent token
    found = await post_service.get_post_by_preview_token("wrong")
    assert found is None

@pytest.mark.asyncio
async def test_list_posts_filters(post_service: PostService, db: AsyncSession):
    """Test listing posts with various filters."""
    p1 = Post(title="P1", slug="p1", content="C", status=PostStatus.PUBLISHED, author_id=1, is_featured=True)
    p2 = Post(title="P2", slug="p2", content="C", status=PostStatus.DRAFT, author_id=2, is_featured=False)
    db.add_all([p1, p2])
    await db.commit()
    
    # Status filter
    posts, _ = await post_service.list_posts(status=PostStatus.DRAFT)
    assert len(posts) == 1
    assert posts[0].id == p2.id
    
    # Author filter
    posts, _ = await post_service.list_posts(author_id=2, include_drafts=True)
    assert len(posts) == 1
    assert posts[0].id == p2.id
    
    # Featured filter
    posts, _ = await post_service.list_posts(featured_only=True)
    assert len(posts) == 1
    assert posts[0].id == p1.id

@pytest.mark.asyncio
async def test_update_post_author_mismatch(post_service: PostService, db: AsyncSession):
    """Test update fails if author ID doesn't match."""
    post = Post(title="P", slug="p", content="C", author_id=1)
    db.add(post)
    await db.commit()
    
    result = await post_service.update_post(post.id, PostUpdate(title="New"), author_id=2)
    assert result is None

@pytest.mark.asyncio
async def test_update_post_regenerate_excerpt(post_service: PostService, db: AsyncSession):
    """Test excerpt is regenerated if content changes."""
    post = Post(title="P", slug="p", content="Old Content", excerpt="Old Excerpt", author_id=1)
    db.add(post)
    await db.commit()
    
    # Update content without excerpt
    await post_service.update_post(post.id, PostUpdate(content="# New Content"))
    await db.refresh(post)
    # Excerpt should be updated (generated from new content)
    assert post.excerpt == "New Content"

@pytest.mark.asyncio
async def test_delete_post_author_mismatch(post_service: PostService, db: AsyncSession):
    """Test delete fails if author ID doesn't match."""
    post = Post(title="P", slug="p", content="C", author_id=1)
    db.add(post)
    await db.commit()
    
    result = await post_service.delete_post(post.id, author_id=2)
    assert result is False

@pytest.mark.asyncio
async def test_not_found_operations(post_service: PostService):
    """Test operations on non-existent posts."""
    assert await post_service.update_post(999, PostUpdate(title="T")) is None
    assert await post_service.delete_post(999) is False
    assert await post_service.publish_post(999) is None
    assert await post_service.withdraw_post(999) is None
    assert await post_service.hide_post(999) is None
    assert await post_service.generate_preview_link(999) is None

@pytest.mark.asyncio
async def test_hide_post(post_service: PostService, db: AsyncSession):
    """Test hiding a post."""
    post = Post(title="P", slug="p", content="C", status=PostStatus.PUBLISHED, author_id=1)
    db.add(post)
    await db.commit()
    
    await post_service.hide_post(post.id)
    await db.refresh(post)
    assert post.status == PostStatus.HIDDEN

@pytest.mark.asyncio
async def test_revoke_preview_link(post_service: PostService, db: AsyncSession):
    """Test revoking preview link."""
    post = Post(title="P", slug="p", content="C", author_id=1, preview_token="t")
    db.add(post)
    await db.commit()
    
    assert await post_service.revoke_preview_link(post.id) is True
    await db.refresh(post)
    assert post.preview_token is None
    
    assert await post_service.revoke_preview_link(999) is False

@pytest.mark.asyncio
async def test_increment_view_count(post_service: PostService):
    """Test incrementing view count."""
    _view_counts_buffer.clear()
    await post_service.increment_view_count(1)
    assert _view_counts_buffer[1] == 1
    await post_service.increment_view_count(1)
    assert _view_counts_buffer[1] == 2

@pytest.mark.asyncio
async def test_render_content(post_service: PostService):
    """Test content rendering."""
    post = Post(title="P", slug="p", content="**Bold**", formatter=PostFormatter.MARKDOWN)
    html = post_service.render_content(post)
    assert "<strong>Bold</strong>" in html

@pytest.mark.asyncio
async def test_create_post_with_tags(post_service: PostService, db: AsyncSession):
    """Test creating post with tags."""
    mock_tag_service = MagicMock()
    mock_tag_service.set_post_tags = AsyncMock()
    
    post_data = PostCreate(title="T", content="C", tags=["tag1"])
    await post_service.create_post_with_tags(post_data, 1, mock_tag_service)
    
    assert mock_tag_service.set_post_tags.called

@pytest.mark.asyncio
async def test_update_post_with_tags(post_service: PostService, db: AsyncSession):
    """Test updating post with tags."""
    post = Post(title="P", slug="p", content="C", author_id=1)
    db.add(post)
    await db.commit()
    
    mock_tag_service = MagicMock()
    mock_tag_service.set_post_tags = AsyncMock()
    
    # Update with tags
    await post_service.update_post_with_tags(
        post.id, 
        PostUpdate(tags=["tag1"]), 
        mock_tag_service
    )
    assert mock_tag_service.set_post_tags.called
    
    # Update non-existent
    res = await post_service.update_post_with_tags(
        999, 
        PostUpdate(tags=["tag1"]), 
        mock_tag_service
    )
    assert res is None

@pytest.mark.asyncio
async def test_get_post_tag_names(post_service: PostService):
    """Test getting tag names."""
    mock_tag = MagicMock()
    mock_tag.name = "Tag1"
    post = MagicMock()
    post.tags = [mock_tag]
    
    names = post_service.get_post_tag_names(post)
    assert names == ["Tag1"]




