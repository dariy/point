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


DEFAULT_PARENT_TAG = "other"


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
            is_hidden=tag_data.is_hidden,
            is_hidden_posts=tag_data.is_hidden_posts,
            show_related_tags_as_children=tag_data.show_related_tags_as_children,
            post_count=0,
        )

        if tag_data.parent_ids:
            parents = await self.db.execute(
                select(Tag).where(Tag.id.in_(tag_data.parent_ids))
            )
            tag.parents = list(parents.scalars().all())
        elif tag_data.name.lower() != DEFAULT_PARENT_TAG:
            # All newly created tags should be children of `other` by default.
            other_tag = await self.get_or_create_tag(DEFAULT_PARENT_TAG)
            tag.parents = [other_tag]

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
        if tag_data.is_hidden is not None:
            tag.is_hidden = tag_data.is_hidden
        if tag_data.is_hidden_posts is not None:
            tag.is_hidden_posts = tag_data.is_hidden_posts
        if tag_data.show_related_tags_as_children is not None:
            tag.show_related_tags_as_children = tag_data.show_related_tags_as_children
        if tag_data.parent_ids is not None:
            parents = await self.db.execute(
                select(Tag).where(Tag.id.in_(tag_data.parent_ids))
            )
            tag.parents = list(parents.scalars().all())
            # Update counts for ancestors
            await self.update_post_counts_recursive([tag.id])

        if tag_data.child_ids is not None:
            children = await self.db.execute(
                select(Tag).where(Tag.id.in_(tag_data.child_ids))
            )
            tag.children = list(children.scalars().all())
            # Update counts for tag and its new children's ancestors
            await self.update_post_counts_recursive([tag.id] + list(tag_data.child_ids))

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
        public_only: bool = False,
    ) -> list[Tag]:
        """List all tags.

        Args:
            include_empty: Include tags with no posts
            important_only: Only return important tags
            search: Optional search term
            sort_by: Column to sort by
            sort_order: Sort order (asc/desc)
            public_only: Whether to filter out hidden tags

        Returns:
            List of tags
        """
        query = select(Tag).options(
            selectinload(Tag.parents), selectinload(Tag.children)
        )

        if public_only:
            hidden_ids = await self.get_publicly_hidden_tag_ids()
            if hidden_ids:
                query = query.where(Tag.id.notin_(hidden_ids))

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

    async def get_related_tags(
        self, tag_id: int, exclude_ids: set[int] | None = None
    ) -> list[Tag]:
        """Get tags that appear on the same posts as the given tag.

        Args:
            tag_id: Tag ID
            exclude_ids: Optional set of tag IDs to exclude

        Returns:
            List of related tags
        """
        if exclude_ids is None:
            exclude_ids = set()
        exclude_ids.add(tag_id)

        # Get post IDs for this tag
        post_ids_query = select(post_tags.c.post_id).where(post_tags.c.tag_id == tag_id)

        # Get related tag IDs
        related_ids_query = (
            select(post_tags.c.tag_id)
            .where(post_tags.c.post_id.in_(post_ids_query))
            .where(post_tags.c.tag_id.notin_(exclude_ids))
            .distinct()
        )

        result = await self.db.execute(
            select(Tag)
            .where(Tag.id.in_(related_ids_query))
            .where(Tag.post_count > 0)
            .order_by(Tag.name)
        )
        return list(result.scalars().all())

    async def get_hierarchical_tags(
        self,
        include_empty: bool = True,
        search: str | None = None,
        public_only: bool = False,
    ) -> list[dict[str, Any]]:
        """Get tags grouped recursively by parents (meta-tags)."""
        # Fetch all tags with their relationships
        all_tags = await self.list_tags(
            include_empty=include_empty, search=search, public_only=public_only
        )

        # Force load all attributes we'll need in templates while in async context
        # This includes loading children and their children recursively
        loaded_ids = set()

        async def ensure_loaded(tag: Tag) -> None:
            """Recursively ensure all tag attributes are loaded."""
            if tag.id in loaded_ids:
                return
            loaded_ids.add(tag.id)

            await tag.awaitable_attrs.parents
            await tag.awaitable_attrs.children
            # Load parents' attributes recursively (for checking hidden ancestors)
            for parent in tag.parents:
                await ensure_loaded(parent)
            # Load children's attributes recursively
            for child in tag.children:
                await ensure_loaded(child)

        for tag in all_tags:
            await ensure_loaded(tag)

        # Determine which tags are "visible"
        visible_ids = {tag.id for tag in all_tags}

        async def build_tree(
            tag: Tag, visible_ids: set[int], show_related: bool, branch_ids: set[int]
        ) -> list[dict[str, Any]]:
            children_trees = []
            # Sort children by name for consistent UI
            # Filter children to only include those in visible_ids first
            filtered_children = [
                child for child in tag.children
                if child.id in visible_ids
            ]
            sorted_children = sorted(filtered_children, key=lambda x: x.name)

            new_branch_ids = branch_ids | {tag.id}

            for child in sorted_children:
                child_tree = await build_tree(
                    child, visible_ids, show_related, new_branch_ids
                )
                # At this point, child is already known to be visible
                # Include child with its tree (which might be empty)
                children_trees.append({"tag": child, "children": child_tree})

            # If this is a leaf and show_related is True, add related tags
            if not children_trees and show_related:
                related = await self.get_related_tags(tag.id, exclude_ids=new_branch_ids)
                for rel in related:
                    # Filter related tags by visible_ids
                    if rel.id in visible_ids:
                        children_trees.append(
                            {"tag": rel, "children": [], "is_related": True}
                        )

            return children_trees

        hierarchy: list[dict[str, Any]] = []

        # Only start from roots (tags with no parents)
        for tag in all_tags:
            if not tag.parents:
                tree = await build_tree(
                    tag, visible_ids, tag.show_related_tags_as_children, set()
                )
                if tag.id in visible_ids or tree:
                    hierarchy.append({"tag": tag, "children": tree})

        # Sort top-level by name
        hierarchy.sort(key=lambda x: x["tag"].name)
        return hierarchy

    async def get_important_tags(self, limit: int = 10) -> list[Tag]:
        """Get important tags for tag cloud."""
        hidden_ids = await self.get_publicly_hidden_tag_ids()
        query = (
            select(Tag)
            .where(Tag.is_important.is_(True))
            .where(Tag.post_count > 0)
        )
        if hidden_ids:
            query = query.where(Tag.id.notin_(hidden_ids))

        result = await self.db.execute(
            query.order_by(Tag.post_count.desc())
            .limit(limit)
        )
        return list(result.scalars().all())

    async def get_featured_tags(self, limit: int = 10) -> list[Tag]:
        """Get featured tags for display in footer."""
        hidden_ids = await self.get_publicly_hidden_tag_ids()
        query = (
            select(Tag)
            .where(Tag.is_featured.is_(True))
            .where(Tag.post_count > 0)
        )
        if hidden_ids:
            query = query.where(Tag.id.notin_(hidden_ids))

        result = await self.db.execute(
            query.order_by(Tag.name)
            .limit(limit)
        )
        return list(result.scalars().all())

    async def get_tag_cloud(self, limit: int = 20, featured: bool = True) -> list[dict[str, Any]]:
        """Get tags for tag cloud with weights."""
        query = select(Tag)
        hidden_ids = await self.get_publicly_hidden_tag_ids()
        if hidden_ids:
            query = query.where(Tag.id.notin_(hidden_ids))

        query = query.where(Tag.post_count > 0)
        if featured:
            query = query.where(Tag.is_featured.is_(True))

        tags = await self.db.execute(query.order_by(Tag.post_count.desc()).limit(limit))
        tag_list = list(tags.scalars().all())

        if not tag_list:
            return []

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

    async def get_posts_by_tag(
        self,
        tag_id: int,
        page: int = 1,
        per_page: int = 10,
        published_only: bool = True,
        recursive: bool = True,
        public_only: bool = False,
        offset: int | None = None,
        featured_only: bool = False,
        exclude_id: int | None = None,
    ) -> tuple[list[Post], int]:
        """Get posts with a specific tag (and its descendants)."""
        if recursive:
            tag_ids = await self.get_descendant_tag_ids(tag_id)
        else:
            tag_ids = {tag_id}

        query = (
            select(Post)
            .join(post_tags, Post.id == post_tags.c.post_id)
            .where(post_tags.c.tag_id.in_(tag_ids))
            .distinct()
        )

        if published_only:
            query = query.where(Post.status == PostStatus.PUBLISHED)

        if featured_only:
            query = query.where(Post.is_featured.is_(True))

        if exclude_id:
            query = query.where(Post.id != exclude_id)

        if public_only:
            hidden_posts_tag_ids = await self.get_hidden_posts_tag_ids()
            if hidden_posts_tag_ids:
                query = query.where(~Post.tags.any(Tag.id.in_(hidden_posts_tag_ids)))

        count_query = select(func.count()).select_from(query.subquery())
        total_result = await self.db.execute(count_query)
        total = total_result.scalar() or 0

        if offset is None:
            offset = (page - 1) * per_page

        query = (
            query.options(selectinload(Post.tags).selectinload(Tag.parents))
            .order_by(Post.published_at.desc().nulls_last(), Post.created_at.desc())
            .offset(offset)
            .limit(per_page)
        )

        result = await self.db.execute(query)
        posts = list(result.scalars().all())

        return posts, total

    async def get_descendant_tag_ids(self, tag_id: int) -> set[int]:
        """Get all descendant tag IDs recursively."""
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
        """Get all ancestor tag IDs recursively."""
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

    async def get_publicly_hidden_tag_ids(self) -> set[int]:
        """Get IDs of all tags that are hidden from public (self or ancestor hidden)."""
        result = await self.db.execute(
            select(Tag.id).where(Tag.is_hidden | Tag.is_hidden_posts)
        )
        hidden_roots = [row[0] for row in result.all()]

        all_hidden = set()
        for root_id in hidden_roots:
            descendants = await self.get_descendant_tag_ids(root_id)
            all_hidden.update(descendants)
        return all_hidden

    async def get_hidden_posts_tag_ids(self) -> set[int]:
        """Get IDs of all tags that hide their posts (self or ancestor has is_hidden_posts)."""
        result = await self.db.execute(
            select(Tag.id).where(Tag.is_hidden_posts)
        )
        hidden_roots = [row[0] for row in result.all()]

        all_hidden = set()
        for root_id in hidden_roots:
            descendants = await self.get_descendant_tag_ids(root_id)
            all_hidden.update(descendants)
        return all_hidden

    async def update_post_count(self, tag_id: int) -> None:
        """Recalculate and update post count for a tag."""
        tag_ids = await self.get_descendant_tag_ids(tag_id)

        count_result = await self.db.execute(
            select(func.count(func.distinct(Post.id)))
            .select_from(post_tags)
            .join(Post, Post.id == post_tags.c.post_id)
            .where(post_tags.c.tag_id.in_(tag_ids))
            .where(Post.status == PostStatus.PUBLISHED)
        )
        count = count_result.scalar() or 0

        tag = await self.get_tag_by_id(tag_id)
        if tag:
            tag.post_count = count
            await self.db.flush()

    async def update_all_post_counts(self) -> None:
        """Recalculate post counts for all tags."""
        tags = await self.list_tags()
        for tag in tags:
            await self.update_post_count(tag.id)

    async def update_post_counts_recursive(self, tag_ids: list[int]) -> None:
        """Update counts for tags and all their ancestors."""
        all_to_update = set()
        for tid in tag_ids:
            ancestors = await self.get_ancestor_tag_ids(tid)
            all_to_update.update(ancestors)

        for tid in all_to_update:
            await self.update_post_count(tid)

    async def add_tags_to_post(self, post: Post, tag_names: list[str]) -> list[Tag]:
        """Add tags to a post, creating new tags if needed."""
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
        await self.update_post_counts_recursive([tag.id for tag in tags])
        return tags

    async def set_post_tags(self, post: Post, tag_names: list[str]) -> list[Tag]:
        """Set post tags (replaces existing tags)."""
        old_tag_ids = [tag.id for tag in post.tags]
        post.tags.clear()
        tags = await self.add_tags_to_post(post, tag_names)
        all_affected_ids = list(set(old_tag_ids) | {t.id for t in tags})
        await self.update_post_counts_recursive(all_affected_ids)
        return tags

    async def remove_tags_from_post(self, post: Post, tag_ids: list[int]) -> None:
        """Remove specific tags from a post."""
        post.tags = [tag for tag in post.tags if tag.id not in tag_ids]
        await self.db.flush()
        await self.update_post_counts_recursive(tag_ids)
