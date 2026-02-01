"""Tests for PostService business logic operations."""

# Standard library
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

# Third-party
from sqlalchemy.ext.asyncio import AsyncSession
import pytest

# Local
from app.models.post import Post, PostFormatter, PostStatus
from app.schemas.post import PostCreate, PostUpdate
from app.services.post_service import PostService, _view_counts_buffer


@pytest.fixture
def post_service(db: AsyncSession):
    """Create PostService instance."""
    return PostService(db)


class TestListPosts:
    """Test cases for listing posts with filters."""

    @pytest.mark.asyncio
    async def test_list_posts_by_author(self, db: AsyncSession) -> None:
        """Test listing posts filtered by author."""
        service = PostService(db)

        # Create posts
        p1 = Post(title="P1", slug="p1", content="c", author_id=1, status=PostStatus.PUBLISHED)
        p2 = Post(title="P2", slug="p2", content="c", author_id=2, status=PostStatus.PUBLISHED)
        db.add_all([p1, p2])
        await db.commit()

        posts, _ = await service.list_posts(author_id=1)
        assert len(posts) == 1
        assert posts[0].title == "P1"

    @pytest.mark.asyncio
    async def test_list_posts_filters(
        self, post_service: PostService, db: AsyncSession
    ) -> None:
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


class TestCreatePost:
    """Test cases for creating posts."""

    @pytest.mark.asyncio
    async def test_create_post_with_excerpt(self, post_service: PostService) -> None:
        """Test creating post with provided excerpt."""
        post_data = PostCreate(
            title="Title",
            content="Content",
            excerpt="Custom Excerpt"
        )
        post = await post_service.create_post(post_data, author_id=1)
        assert post.excerpt == "Custom Excerpt"

    @pytest.mark.asyncio
    async def test_create_post_with_tags(self, post_service: PostService, db: AsyncSession) -> None:
        """Test creating post with tags."""
        mock_tag_service = MagicMock()
        mock_tag_service.set_post_tags = AsyncMock()

        post_data = PostCreate(title="T", content="C", tags=["tag1"])
        await post_service.create_post_with_tags(post_data, 1, mock_tag_service)

        assert mock_tag_service.set_post_tags.called


class TestGetPost:
    """Test cases for retrieving posts."""

    @pytest.mark.asyncio
    async def test_get_post_by_slug_include_drafts(
        self, post_service: PostService, db: AsyncSession
    ) -> None:
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
    async def test_get_post_by_preview_token_invalid(
        self, post_service: PostService, db: AsyncSession
    ) -> None:
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


class TestUpdatePost:
    """Test cases for updating posts."""

    @pytest.mark.asyncio
    async def test_update_post_enum_conversion(self, db: AsyncSession) -> None:
        """Test updating post with Enum value triggers value conversion."""
        service = PostService(db)
        post = Post(title="P", slug="p", content="c", author_id=1, status=PostStatus.DRAFT)
        db.add(post)
        await db.commit()

        # Update with Enum
        await service.update_post(post.id, PostUpdate(status=PostStatus.PUBLISHED))
        await db.refresh(post)
        assert post.status == PostStatus.PUBLISHED.value

    @pytest.mark.asyncio
    async def test_update_post_sets_published_at(self, db: AsyncSession) -> None:
        """Test setting status to PUBLISHED sets published_at."""
        service = PostService(db)
        post = Post(title="P", slug="p", content="c", author_id=1, status=PostStatus.DRAFT, published_at=None)
        db.add(post)
        await db.commit()

        await service.update_post(post.id, PostUpdate(status=PostStatus.PUBLISHED))
        await db.refresh(post)
        assert post.published_at is not None

    @pytest.mark.asyncio
    async def test_update_post_regenerates_excerpt(self, db: AsyncSession) -> None:
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
    async def test_update_post_author_mismatch(
        self, post_service: PostService, db: AsyncSession
    ) -> None:
        """Test update fails if author ID doesn't match."""
        post = Post(title="P", slug="p", content="C", author_id=1)
        db.add(post)
        await db.commit()

        result = await post_service.update_post(post.id, PostUpdate(title="New"), author_id=2)
        assert result is None

    @pytest.mark.asyncio
    async def test_update_post_regenerate_excerpt(
        self, post_service: PostService, db: AsyncSession
    ) -> None:
        """Test excerpt is regenerated if content changes."""
        post = Post(title="P", slug="p", content="Old Content", excerpt="Old Excerpt", author_id=1)
        db.add(post)
        await db.commit()

        # Update content without excerpt
        await post_service.update_post(post.id, PostUpdate(content="# New Content"))
        await db.refresh(post)
        # Excerpt should be updated
        assert post.excerpt == "New Content"

    @pytest.mark.asyncio
    async def test_update_post_with_tags(
        self, post_service: PostService, db: AsyncSession
    ) -> None:
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
    async def test_update_post_with_tags_not_found(self, db: AsyncSession) -> None:
        """Test updating non-existent post with tags returns None."""
        service = PostService(db)
        tag_service = MagicMock()

        result = await service.update_post_with_tags(999, PostUpdate(title="T"), tag_service)
        assert result is None


class TestDeletePost:
    """Test cases for deleting posts."""

    @pytest.mark.asyncio
    async def test_delete_post_author_mismatch(self, db: AsyncSession) -> None:
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
    async def test_delete_post_author_mismatch_alternate(
        self, post_service: PostService, db: AsyncSession
    ) -> None:
        """Test delete fails if author ID doesn't match."""
        post = Post(title="P", slug="p", content="C", author_id=1)
        db.add(post)
        await db.commit()

        result = await post_service.delete_post(post.id, author_id=2)
        assert result is False


class TestStatusTransitions:
    """Test cases for post status transitions."""

    @pytest.mark.asyncio
    async def test_hide_post(
        self, post_service: PostService, db: AsyncSession
    ) -> None:
        """Test hiding a post."""
        post = Post(title="P", slug="p", content="C", status=PostStatus.PUBLISHED, author_id=1)
        db.add(post)
        await db.commit()

        await post_service.hide_post(post.id)
        await db.refresh(post)
        assert post.status == PostStatus.HIDDEN


class TestPreviewLinks:
    """Test cases for preview link operations."""

    @pytest.mark.asyncio
    async def test_revoke_preview_link(
        self, post_service: PostService, db: AsyncSession
    ) -> None:
        """Test revoking preview link."""
        post = Post(title="P", slug="p", content="C", author_id=1, preview_token="t")
        db.add(post)
        await db.commit()

        assert await post_service.revoke_preview_link(post.id) is True
        await db.refresh(post)
        assert post.preview_token is None

        assert await post_service.revoke_preview_link(999) is False


class TestContentRendering:
    """Test cases for content rendering."""

    @pytest.mark.asyncio
    async def test_render_content(self, post_service: PostService) -> None:
        """Test content rendering."""
        post = Post(title="P", slug="p", content="**Bold**", formatter=PostFormatter.MARKDOWN)
        html = post_service.render_content(post)
        assert "<strong>Bold</strong>" in html


class TestSlugGeneration:
    """Test cases for slug generation."""

    @pytest.mark.asyncio
    async def test_get_existing_slugs_exclude_id(
        self, post_service: PostService, db: AsyncSession
    ) -> None:
        """Test getting existing slugs excluding a specific ID."""
        # Create two posts
        post1 = Post(title="Post 1", slug="post-1", content="Content", author_id=1)
        post2 = Post(title="Post 2", slug="post-2", content="Content", author_id=1)
        db.add_all([post1, post2])
        await db.commit()

        slugs = await post_service._get_existing_slugs(exclude_id=post1.id)
        assert "post-1" not in slugs
        assert "post-2" in slugs


class TestTagOperations:
    """Test cases for tag operations."""

    @pytest.mark.asyncio
    async def test_get_post_tag_names(self, post_service: PostService) -> None:
        """Test getting tag names."""
        mock_tag = MagicMock()
        mock_tag.name = "Tag1"
        post = MagicMock()
        post.tags = [mock_tag]

        names = post_service.get_post_tag_names(post)
        assert names == ["Tag1"]


class TestCacheInvalidation:
    """Test cases for cache invalidation."""

    @pytest.mark.asyncio
    async def test_cache_invalidation_exceptions(self, db: AsyncSession) -> None:
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


class TestNotFoundOperations:
    """Test cases for operations on non-existent posts."""

    @pytest.mark.asyncio
    async def test_not_found_operations(self, post_service: PostService) -> None:
        """Test operations on non-existent posts."""
        assert await post_service.update_post(999, PostUpdate(title="T")) is None
        assert await post_service.delete_post(999) is False
        assert await post_service.publish_post(999) is None
        assert await post_service.withdraw_post(999) is None
        assert await post_service.hide_post(999) is None
        assert await post_service.generate_preview_link(999) is None
