"""Tag service for managing tags.

Handles CRUD operations, post-tag relationships, and tag cloud generation.
"""

import logging
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.post import Post, PostStatus
from app.models.post_tag import post_tags
from app.models.tag import Tag
from app.schemas.tag import TagCreate, TagUpdate
from app.services.cache_service import invalidate_cache_for_tag
from app.utils.slugify import make_unique_slug, slugify

logger = logging.getLogger(__name__)


class TagService:
    """Service for managing tags."""

    def __init__(self, db: AsyncSession):
        """Initialize tag service.

        Args:
            db: Async database session
        """
        self.db = db

    async def _get_existing_slugs(self, exclude_id: int | None = None) -> set[str]:
        """Get all existing tag slugs.

        Args:
            exclude_id: Optional tag ID to exclude

        Returns:
            Set of existing slugs
        """
        query = select(Tag.slug)
        if exclude_id:
            query = query.where(Tag.id != exclude_id)

        result = await self.db.execute(query)
        return {row[0] for row in result.all()}

    async def _generate_unique_slug(
        self, name: str, exclude_id: int | None = None
    ) -> str:
        """Generate a unique slug from name.

        Args:
            name: Tag name
            exclude_id: Optional tag ID to exclude from uniqueness check

        Returns:
            Unique slug
        """
        base_slug = slugify(name)
        existing_slugs = await self._get_existing_slugs(exclude_id)
        return make_unique_slug(base_slug, existing_slugs)

    async def create_tag(self, tag_data: TagCreate) -> Tag:
        """Create a new tag.

        Args:
            tag_data: Tag creation data

        Returns:
            Created tag

        Raises:
            ValueError: If tag name already exists
        """
        # Check if name already exists
        existing = await self.get_tag_by_name(tag_data.name)
        if existing:
            raise ValueError(f"Tag with name '{tag_data.name}' already exists")

        # Generate slug
        slug = await self._generate_unique_slug(tag_data.name)

        tag = Tag(
            name=tag_data.name,
            slug=slug,
            description=tag_data.description,
            custom_url=tag_data.custom_url,
            is_important=tag_data.is_important,
            is_featured=tag_data.is_featured,
            post_count=0,
        )

        if tag_data.parent_ids:
            parents = await self.db.execute(
                select(Tag).where(Tag.id.in_(tag_data.parent_ids))
            )
            tag.parents = list(parents.scalars().all())

        if tag_data.child_ids:
            children = await self.db.execute(
                select(Tag).where(Tag.id.in_(tag_data.child_ids))
            )
            tag.children = list(children.scalars().all())

        self.db.add(tag)
        await self.db.flush()
        await self.db.refresh(tag, attribute_names=["parents", "children"])

        return tag

    async def get_or_create_tag(self, name: str) -> Tag:
        """Get existing tag or create new one by name.

        Args:
            name: Tag name

        Returns:
            Existing or newly created tag
        """
        existing = await self.get_tag_by_name(name)
        if existing:
            return existing

        tag_data = TagCreate(name=name)
        return await self.create_tag(tag_data)

    async def get_tag_by_id(self, tag_id: int) -> Tag | None:
        """Get tag by ID.

        Args:
            tag_id: Tag ID

        Returns:
            Tag if found, None otherwise
        """
        result = await self.db.execute(
            select(Tag)
            .where(Tag.id == tag_id)
            .options(selectinload(Tag.parents), selectinload(Tag.children))
        )
        return result.scalars().first()

    async def get_tag_by_slug(self, slug: str) -> Tag | None:
        """Get tag by slug.

        Args:
            slug: Tag slug

        Returns:
            Tag if found, None otherwise
        """
        result = await self.db.execute(
            select(Tag)
            .where(Tag.slug == slug)
            .options(selectinload(Tag.parents), selectinload(Tag.children))
        )
        return result.scalars().first()

    async def get_tag_by_name(self, name: str) -> Tag | None:
        """Get tag by name (case-insensitive).

        Args:
            name: Tag name

        Returns:
            Tag if found, None otherwise
        """
        result = await self.db.execute(
            select(Tag)
            .where(func.lower(Tag.name) == func.lower(name))
            .options(selectinload(Tag.parents), selectinload(Tag.children))
        )
        return result.scalars().first()

    async def update_tag(self, tag_id: int, tag_data: TagUpdate) -> Tag | None:
        """Update a tag.

        Args:
            tag_id: Tag ID
            tag_data: Update data

        Returns:
            Updated tag if found, None otherwise

        Raises:
            ValueError: If new name conflicts with existing tag
        """
        tag = await self.get_tag_by_id(tag_id)
        if not tag:
            return None

        # Check name conflict if name is being changed
        if tag_data.name is not None and tag_data.name != tag.name:
            existing = await self.get_tag_by_name(tag_data.name)
            if existing and existing.id != tag_id:
                raise ValueError(f"Tag with name '{tag_data.name}' already exists")
            tag.name = tag_data.name
            # Only auto-update slug if slug is not explicitly provided
            if tag_data.slug is None:
                tag.slug = await self._generate_unique_slug(tag_data.name, tag_id)

        # Handle explicit slug update
        if tag_data.slug is not None and tag_data.slug != tag.slug:
            existing = await self.get_tag_by_slug(tag_data.slug)
            if existing and existing.id != tag_id:
                raise ValueError(f"Tag with slug '{tag_data.slug}' already exists")
            tag.slug = tag_data.slug

        if tag_data.description is not None:
            tag.description = tag_data.description
        if tag_data.custom_url is not None:
            tag.custom_url = tag_data.custom_url
        if tag_data.is_important is not None:
            tag.is_important = tag_data.is_important
        if tag_data.is_featured is not None:
            tag.is_featured = tag_data.is_featured
        if tag_data.parent_ids is not None:
            parents = await self.db.execute(
                select(Tag).where(Tag.id.in_(tag_data.parent_ids))
            )
            tag.parents = list(parents.scalars().all())

        if tag_data.child_ids is not None:
            children = await self.db.execute(
                select(Tag).where(Tag.id.in_(tag_data.child_ids))
            )
            tag.children = list(children.scalars().all())

        await self.db.flush()
        await self.db.refresh(tag, attribute_names=["parents", "children"])

        # Invalidate cache when a tag is updated
        try:
            await invalidate_cache_for_tag()
            logger.debug("Cache invalidated after tag update")
        except Exception as e:
            logger.warning("Failed to invalidate cache: %s", e)

        return tag

    async def delete_tag(self, tag_id: int) -> bool:
        """Delete a tag.

        This removes the tag and all its post associations.

        Args:
            tag_id: Tag ID

        Returns:
            True if deleted, False if not found
        """
        tag = await self.get_tag_by_id(tag_id)
        if not tag:
            return False

        await self.db.delete(tag)
        await self.db.flush()

        # Invalidate cache when a tag is deleted
        try:
            await invalidate_cache_for_tag()
            logger.debug("Cache invalidated after tag deletion")
        except Exception as e:
            logger.warning("Failed to invalidate cache: %s", e)

        return True

    async def list_tags(
        self,
        include_empty: bool = True,
        important_only: bool = False,
        search: str | None = None,
        parent_id: int | None = None,
        sort_by: str = "name",
        sort_order: str = "asc",
    ) -> list[Tag]:
        """List all tags.

        Args:
            include_empty: Include tags with no posts
            important_only: Only return important tags
            search: Optional search term
            sort_by: Column to sort by
            sort_order: Sort order (asc/desc)

        Returns:
            List of tags
        """
        query = select(Tag).options(
            selectinload(Tag.parents), selectinload(Tag.children)
        )

        if not include_empty:
            query = query.where(Tag.post_count > 0)

        if important_only:
            query = query.where(Tag.is_important.is_(True))

        if search:
            query = query.where(Tag.name.ilike(f"%{search}%"))

        if parent_id:
            query = query.where(Tag.parents.any(Tag.id == parent_id))

        # Apply sorting
        column = getattr(Tag, sort_by, Tag.name)
        if sort_order.lower() == "desc":
            query = query.order_by(column.desc())
        else:
            query = query.order_by(column.asc())

        # Add secondary sort by name for stability (if not already sorting by name)
        if sort_by != "name":
            query = query.order_by(Tag.name.asc())

        result = await self.db.execute(query)
        return list(result.scalars().all())

    async def get_hierarchical_tags(
        self,
        include_empty: bool = True,
        search: str | None = None,
    ) -> list[dict[str, Any]]:
        """Get tags grouped by parents (meta-tags).

        Returns:
            List of meta-tags (tags with children) and top-level tags.
        """
        # Always fetch all tags to ensure we have the structural context (parents).
        # Otherwise children with parents are skipped if their parents are missing from
        # the list because they have no posts (when include_empty=False).
        all_tags = await self.list_tags(include_empty=True)

        # Identify which tags are actually "visible" based on filters
        if not include_empty or search:
            # Re-fetch with filters to get the "target" tags
            visible_tags = await self.list_tags(include_empty=include_empty, search=search)
            visible_ids = {t.id for t in visible_tags}
        else:
            visible_ids = {t.id for t in all_tags}

        hierarchy: list[dict[str, Any]] = []

        for tag in all_tags:
            # Only top-level tags (those with no parents) act as group roots in our 2-level UI
            if not tag.parents:
                # Filter children to only those that should be visible
                children = [t for t in tag.children if t.id in visible_ids]

                # Tag itself should be shown if it's visible OR has visible children
                if tag.id in visible_ids or children:
                    hierarchy.append(
                        {
                            "tag": tag,
                            "children": children,
                        }
                    )

        # Sort by tag name
        hierarchy.sort(key=lambda x: str(x["tag"].name))
        return hierarchy

    async def get_important_tags(self, limit: int = 10) -> list[Tag]:
        """Get important tags for tag cloud.

        Args:
            limit: Maximum number of tags

        Returns:
            List of important tags sorted by post count
        """
        result = await self.db.execute(
            select(Tag)
            .where(Tag.is_important.is_(True))
            .where(Tag.post_count > 0)
            .order_by(Tag.post_count.desc())
            .limit(limit)
        )
        return list(result.scalars().all())

    async def get_featured_tags(self, limit: int = 10) -> list[Tag]:
        """Get featured tags for display in footer.

        Args:
            limit: Maximum number of tags

        Returns:
            List of featured tags sorted by name
        """
        result = await self.db.execute(
            select(Tag)
            .where(Tag.is_featured.is_(True))
            .where(Tag.post_count > 0)
            .order_by(Tag.name)
            .limit(limit)
        )
        return list(result.scalars().all())

    async def get_tag_cloud(self, limit: int = 20, featured: bool = True) -> list[dict[str, Any]]:
        """Get tags for tag cloud with weights.

        Args:
            limit: Maximum number of tags
            featured: Only include featured tags

        Returns:
            List of tag dicts with weight (0-1)
        """
        query = select(Tag).where(Tag.post_count > 0)

        if featured:
            query = query.where(Tag.is_featured.is_(True))

        tags = await self.db.execute(query.order_by(Tag.post_count.desc()).limit(limit))
        tag_list = list(tags.scalars().all())

        if not tag_list:
            return []

        # Calculate weights based on post counts
        max_count = max(t.post_count for t in tag_list)
        min_count = min(t.post_count for t in tag_list)
        count_range = max_count - min_count or 1

        return [
            {
                "id": tag.id,
                "name": tag.name,
                "slug": tag.slug,
                "post_count": tag.post_count,
                "weight": (tag.post_count - min_count) / count_range,
            }
            for tag in tag_list
        ]

    async def update_post_count(self, tag_id: int) -> None:
        """Recalculate and update post count for a tag.

        This counts published posts associated with this tag or any of its
        descendants (sub-tags) recursively.

        Args:
            tag_id: Tag ID
        """
        # Get all descendant IDs to count posts from sub-tags as well
        tag_ids = await self.get_descendant_tag_ids(tag_id)

        # Count published posts with any of these tags
        count_result = await self.db.execute(
            select(func.count(func.distinct(Post.id)))
            .select_from(post_tags)
            .join(Post, Post.id == post_tags.c.post_id)
            .where(post_tags.c.tag_id.in_(tag_ids))
            .where(Post.status == PostStatus.PUBLISHED)
        )
        count = count_result.scalar() or 0

        # Update the tag
        tag = await self.get_tag_by_id(tag_id)
        if tag:
            tag.post_count = count
            await self.db.flush()

    async def update_all_post_counts(self) -> None:
        """Recalculate post counts for all tags."""
        tags = await self.list_tags()
        for tag in tags:
            await self.update_post_count(tag.id)

    async def get_posts_by_tag(
        self,
        tag_id: int,
        page: int = 1,
        per_page: int = 10,
        published_only: bool = True,
        recursive: bool = True,
    ) -> tuple[list[Post], int]:
        """Get posts with a specific tag (and its descendants).

        Args:
            tag_id: Tag ID
            page: Page number
            per_page: Items per page
            published_only: Only return published posts
            recursive: Whether to include posts from sub-tags

        Returns:
            Tuple of (posts, total_count)
        """
        # Get all relevant tag IDs
        if recursive:
            tag_ids = await self.get_descendant_tag_ids(tag_id)
        else:
            tag_ids = {tag_id}

        # Base query
        query = (
            select(Post)
            .join(post_tags, Post.id == post_tags.c.post_id)
            .where(post_tags.c.tag_id.in_(tag_ids))
            .distinct()
        )

        if published_only:
            query = query.where(Post.status == PostStatus.PUBLISHED)

        # Get total count
        count_query = select(func.count()).select_from(query.subquery())
        total_result = await self.db.execute(count_query)
        total = total_result.scalar() or 0

        # Get paginated results
        offset = (page - 1) * per_page
        query = (
            query.options(selectinload(Post.tags))
            .order_by(Post.published_at.desc().nulls_last(), Post.created_at.desc())
            .offset(offset)
            .limit(per_page)
        )

        result = await self.db.execute(query)
        posts = list(result.scalars().all())

        return posts, total

    async def get_descendant_tag_ids(self, tag_id: int) -> set[int]:
        """Get all descendant tag IDs recursively, avoiding circular references.

        Args:
            tag_id: Root tag ID

        Returns:
            Set of tag IDs including the root and all descendants
        """
        # Fetch all tags with their children to build the graph in memory
        result = await self.db.execute(
            select(Tag).options(selectinload(Tag.children))
        )
        all_tags = {t.id: t for t in result.scalars().all()}

        if tag_id not in all_tags:
            return {tag_id}

        descendant_ids = {tag_id}
        queue = [tag_id]
        visited = {tag_id}

        while queue:
            curr_id = queue.pop(0)
            tag = all_tags.get(curr_id)
            if tag:
                for child in tag.children:
                    if child.id not in visited:
                        visited.add(child.id)
                        descendant_ids.add(child.id)
                        queue.append(child.id)
        return descendant_ids

    async def get_ancestor_tag_ids(self, tag_id: int) -> set[int]:
        """Get all ancestor tag IDs recursively, avoiding circular references.

        Args:
            tag_id: Tag ID

        Returns:
            Set of tag IDs including the tag and all its ancestors
        """
        result = await self.db.execute(
            select(Tag).options(selectinload(Tag.parents))
        )
        all_tags = {t.id: t for t in result.scalars().all()}

        if tag_id not in all_tags:
            return {tag_id}

        ancestor_ids = {tag_id}
        queue = [tag_id]
        visited = {tag_id}

        while queue:
            curr_id = queue.pop(0)
            tag = all_tags.get(curr_id)
            if tag:
                for parent in tag.parents:
                    if parent.id not in visited:
                        visited.add(parent.id)
                        ancestor_ids.add(parent.id)
                        queue.append(parent.id)
        return ancestor_ids

    async def update_post_counts_recursive(self, tag_ids: list[int]) -> None:
        """Update counts for tags and all their ancestors.

        Args:
            tag_ids: List of tag IDs that were affected
        """
        all_to_update = set()
        for tid in tag_ids:
            ancestors = await self.get_ancestor_tag_ids(tid)
            all_to_update.update(ancestors)

        for tid in all_to_update:
            await self.update_post_count(tid)

    async def add_tags_to_post(self, post: Post, tag_names: list[str]) -> list[Tag]:
        """Add tags to a post, creating new tags if needed.

        Args:
            post: Post to tag
            tag_names: List of tag names

        Returns:
            List of tags added
        """
        tags = []
        for name in tag_names:
            name = name.strip()
            if not name:
                continue
            tag = await self.get_or_create_tag(name)
            if tag not in post.tags:
                post.tags.append(tag)
            tags.append(tag)

        await self.db.flush()

        # Update post counts for affected tags (and ancestors)
        await self.update_post_counts_recursive([tag.id for tag in tags])

        return tags

    async def set_post_tags(self, post: Post, tag_names: list[str]) -> list[Tag]:
        """Set post tags (replaces existing tags).

        Args:
            post: Post to update
            tag_names: New list of tag names

        Returns:
            List of new tags
        """
        # Get current tag IDs for count update
        old_tag_ids = [tag.id for tag in post.tags]

        # Clear existing tags
        post.tags.clear()

        # Add new tags
        tags = await self.add_tags_to_post(post, tag_names)

        # Update counts for removed tags (and ancestors)
        all_affected_ids = list(set(old_tag_ids) | {t.id for t in tags})
        await self.update_post_counts_recursive(all_affected_ids)

        return tags

    async def remove_tags_from_post(self, post: Post, tag_ids: list[int]) -> None:
        """Remove specific tags from a post.

        Args:
            post: Post to update
            tag_ids: List of tag IDs to remove
        """
        post.tags = [tag for tag in post.tags if tag.id not in tag_ids]
        await self.db.flush()

        # Update post counts (and ancestors)
        await self.update_post_counts_recursive(tag_ids)
