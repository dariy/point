"""Post service for blog content management.

Handles CRUD operations, slug generation, status transitions, and preview links.
"""

import secrets
from datetime import datetime, timedelta

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostStatus
from app.schemas.post import PostCreate, PostUpdate
from app.utils.formatters import format_content, generate_excerpt
from app.utils.slugify import make_unique_slug, slugify


class PostService:
    """Service for managing blog posts."""

    def __init__(self, db: AsyncSession):
        """Initialize post service.

        Args:
            db: Async database session
        """
        self.db = db

    async def _get_existing_slugs(self, exclude_id: int | None = None) -> set[str]:
        """Get all existing slugs.

        Args:
            exclude_id: Optional post ID to exclude

        Returns:
            Set of existing slugs
        """
        query = select(Post.slug)
        if exclude_id:
            query = query.where(Post.id != exclude_id)

        result = await self.db.execute(query)
        return {row[0] for row in result.all()}

    async def _generate_unique_slug(
        self, title: str, exclude_id: int | None = None
    ) -> str:
        """Generate a unique slug from title.

        Args:
            title: Post title
            exclude_id: Optional post ID to exclude from uniqueness check

        Returns:
            Unique slug
        """
        base_slug = slugify(title)
        existing_slugs = await self._get_existing_slugs(exclude_id)
        return make_unique_slug(base_slug, existing_slugs)

    async def create_post(
        self, post_data: PostCreate, author_id: int
    ) -> Post:
        """Create a new post.

        Args:
            post_data: Post creation data
            author_id: ID of the author

        Returns:
            Created post
        """
        # Generate slug
        slug = await self._generate_unique_slug(post_data.title)

        # Generate excerpt if not provided
        excerpt = post_data.excerpt
        if not excerpt:
            excerpt = generate_excerpt(
                post_data.content, post_data.formatter.value
            )

        post = Post(
            title=post_data.title,
            slug=slug,
            content=post_data.content,
            excerpt=excerpt,
            formatter=post_data.formatter.value,
            status=post_data.status.value,
            is_featured=post_data.is_featured,
            thumbnail_path=post_data.thumbnail_path,
            custom_url=post_data.custom_url,
            meta_description=post_data.meta_description,
            author_id=author_id,
        )

        self.db.add(post)
        await self.db.flush()
        await self.db.refresh(post)

        return post

    async def get_post_by_id(
        self, post_id: int, include_hidden: bool = False
    ) -> Post | None:
        """Get post by ID.

        Args:
            post_id: Post ID
            include_hidden: Include hidden posts

        Returns:
            Post if found, None otherwise
        """
        query = select(Post).where(Post.id == post_id)

        if not include_hidden:
            query = query.where(Post.status != PostStatus.HIDDEN)

        result = await self.db.execute(query)
        return result.scalar_one_or_none()

    async def get_post_by_slug(
        self, slug: str, include_drafts: bool = False
    ) -> Post | None:
        """Get post by slug.

        Args:
            slug: Post slug
            include_drafts: Include draft posts

        Returns:
            Post if found, None otherwise
        """
        query = select(Post).where(
            or_(Post.slug == slug, Post.custom_url == slug)
        )

        if not include_drafts:
            query = query.where(Post.status == PostStatus.PUBLISHED)

        result = await self.db.execute(query)
        return result.scalar_one_or_none()

    async def get_post_by_preview_token(self, token: str) -> Post | None:
        """Get post by preview token.

        Args:
            token: Preview token

        Returns:
            Post if valid token, None otherwise
        """
        result = await self.db.execute(
            select(Post).where(Post.preview_token == token)
        )
        post = result.scalar_one_or_none()

        if post and post.preview_is_valid:
            return post

        return None

    async def list_posts(
        self,
        page: int = 1,
        per_page: int = 10,
        status: PostStatus | None = None,
        author_id: int | None = None,
        featured_only: bool = False,
        include_drafts: bool = False,
    ) -> tuple[list[Post], int]:
        """List posts with pagination and filters.

        Args:
            page: Page number (1-indexed)
            per_page: Items per page
            status: Filter by status
            author_id: Filter by author
            featured_only: Only featured posts
            include_drafts: Include draft posts

        Returns:
            Tuple of (posts, total_count)
        """
        query = select(Post)

        # Apply filters
        if status:
            query = query.where(Post.status == status)
        elif not include_drafts:
            query = query.where(Post.status == PostStatus.PUBLISHED)

        if author_id:
            query = query.where(Post.author_id == author_id)

        if featured_only:
            query = query.where(Post.is_featured.is_(True))

        # Get total count
        count_query = select(func.count()).select_from(query.subquery())
        total_result = await self.db.execute(count_query)
        total = total_result.scalar() or 0

        # Apply pagination and ordering
        query = (
            query.order_by(Post.published_at.desc().nulls_last(), Post.created_at.desc())
            .offset((page - 1) * per_page)
            .limit(per_page)
        )

        result = await self.db.execute(query)
        posts = list(result.scalars().all())

        return posts, total

    async def update_post(
        self, post_id: int, post_data: PostUpdate, author_id: int | None = None
    ) -> Post | None:
        """Update an existing post.

        Args:
            post_id: Post ID
            post_data: Update data
            author_id: Optional author ID for authorization check

        Returns:
            Updated post or None if not found
        """
        post = await self.get_post_by_id(post_id, include_hidden=True)
        if not post:
            return None

        if author_id and post.author_id != author_id:
            return None

        # Update fields that are provided
        update_data = post_data.model_dump(exclude_unset=True, exclude={"tags"})

        for field, value in update_data.items():
            if value is not None:
                # Convert enums to their values
                if hasattr(value, "value"):
                    value = value.value
                setattr(post, field, value)

        # Regenerate excerpt if content changed and no custom excerpt
        if post_data.content and not post_data.excerpt:
            post.excerpt = generate_excerpt(post.content, post.formatter)

        await self.db.flush()
        await self.db.refresh(post)

        return post

    async def delete_post(
        self, post_id: int, author_id: int | None = None
    ) -> bool:
        """Delete a post.

        Args:
            post_id: Post ID
            author_id: Optional author ID for authorization check

        Returns:
            True if deleted, False if not found
        """
        post = await self.get_post_by_id(post_id, include_hidden=True)
        if not post:
            return False

        if author_id and post.author_id != author_id:
            return False

        await self.db.delete(post)
        await self.db.flush()
        return True

    async def publish_post(self, post_id: int) -> Post | None:
        """Publish a draft post.

        Args:
            post_id: Post ID

        Returns:
            Updated post or None if not found
        """
        post = await self.get_post_by_id(post_id, include_hidden=True)
        if not post:
            return None

        post.status = PostStatus.PUBLISHED
        post.published_at = datetime.utcnow()

        # Clear preview token on publish
        post.preview_token = None
        post.preview_expires_at = None

        await self.db.flush()
        await self.db.refresh(post)

        return post

    async def withdraw_post(self, post_id: int) -> Post | None:
        """Withdraw a published post to draft.

        Args:
            post_id: Post ID

        Returns:
            Updated post or None if not found
        """
        post = await self.get_post_by_id(post_id, include_hidden=True)
        if not post:
            return None

        post.status = PostStatus.DRAFT

        await self.db.flush()
        await self.db.refresh(post)

        return post

    async def hide_post(self, post_id: int) -> Post | None:
        """Hide a post (accessible only via direct URL).

        Args:
            post_id: Post ID

        Returns:
            Updated post or None if not found
        """
        post = await self.get_post_by_id(post_id, include_hidden=True)
        if not post:
            return None

        post.status = PostStatus.HIDDEN

        await self.db.flush()
        await self.db.refresh(post)

        return post

    async def generate_preview_link(
        self, post_id: int, expires_days: int = 7
    ) -> tuple[str, datetime] | None:
        """Generate a preview link for a draft post.

        Args:
            post_id: Post ID
            expires_days: Days until link expires

        Returns:
            Tuple of (token, expires_at) or None if not found
        """
        post = await self.get_post_by_id(post_id, include_hidden=True)
        if not post:
            return None

        # Generate new token
        token = secrets.token_urlsafe(32)
        expires_at = datetime.utcnow() + timedelta(days=expires_days)

        post.preview_token = token
        post.preview_expires_at = expires_at

        await self.db.flush()

        return token, expires_at

    async def revoke_preview_link(self, post_id: int) -> bool:
        """Revoke a preview link.

        Args:
            post_id: Post ID

        Returns:
            True if revoked, False if not found
        """
        result = await self.db.execute(
            update(Post)
            .where(Post.id == post_id)
            .values(preview_token=None, preview_expires_at=None)
        )
        return bool(result.rowcount > 0)  # type: ignore[attr-defined]

    async def increment_view_count(self, post_id: int) -> None:
        """Increment post view count.

        Args:
            post_id: Post ID
        """
        await self.db.execute(
            update(Post)
            .where(Post.id == post_id)
            .values(view_count=Post.view_count + 1)
        )

    def render_content(self, post: Post) -> str:
        """Render post content to HTML.

        Args:
            post: Post to render

        Returns:
            HTML content
        """
        return format_content(post.content, post.formatter)
