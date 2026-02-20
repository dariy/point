"""Tag API endpoints.

Handles CRUD operations for tags and tag-post relationships.
"""

import math
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_auth
from app.models.tag import Tag as TagModel
from app.models.user import User
from app.schemas.tag import (
    TagCloudResponse,
    TagCreate,
    TagListResponse,
    TagReorder,
    TagResponse,
    TagUpdate,
    TagWithPostsResponse,
)
from app.services.settings_service import SettingsService
from app.services.tag_service import TagService

router = APIRouter(prefix="/api/tags", tags=["Tags"])


def tag_to_response(tag: TagModel) -> dict[str, Any]:
    """Convert Tag model to response dict.

    Args:
        tag: Tag model instance

    Returns:
        Dict suitable for TagResponse
    """
    return {
        "id": tag.id,
        "name": tag.name,
        "slug": tag.slug,
        "description": tag.description,
        "custom_url": tag.custom_url,
        "is_important": tag.is_important,
        "is_featured": tag.is_featured,
        "is_hidden": tag.is_hidden,
        "is_hidden_posts": tag.is_hidden_posts,
        "include_in_breadcrumbs": tag.include_in_breadcrumbs,
        "show_related_tags_as_children": tag.show_related_tags_as_children,
        "sort_order": tag.sort_order,
        "post_count": tag.post_count,
        "created_at": tag.created_at,
        "url": tag.url,
        "parents": [tag_to_list_item(p) for p in tag.parents],
        "children": [tag_to_list_item(c) for c in tag.children],
    }


def tag_to_list_item(tag: TagModel) -> dict[str, Any]:
    """Convert Tag model to list item dict.

    Args:
        tag: Tag model instance

    Returns:
        Dict suitable for TagListItem
    """
    return {
        "id": tag.id,
        "name": tag.name,
        "slug": tag.slug,
        "is_important": tag.is_important,
        "is_hidden": tag.is_hidden,
        "is_hidden_posts": tag.is_hidden_posts,
        "include_in_breadcrumbs": tag.include_in_breadcrumbs,
        "sort_order": tag.sort_order,
        "post_count": tag.post_count,
    }


@router.get(
    "",
    response_model=TagListResponse,
    summary="List all tags",
)
async def list_tags(
    include_empty: bool = Query(default=True, description="Include tags with no posts"),
    important_only: bool = Query(
        default=False, description="Only return important tags"
    ),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """List all tags.

    This endpoint is publicly accessible.
    """
    service = TagService(db)
    tags = await service.list_tags(
        include_empty=include_empty,
        important_only=important_only,
    )

    return {
        "tags": [tag_to_list_item(t) for t in tags],
        "total": len(tags),
    }


@router.get(
    "/cloud",
    response_model=TagCloudResponse,
    summary="Get tag cloud",
)
async def get_tag_cloud(
    limit: int = Query(default=20, ge=1, le=100, description="Maximum number of tags"),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Get tags for tag cloud display with weights.

    This endpoint is publicly accessible.
    """
    service = TagService(db)
    cloud = await service.get_tag_cloud(limit=limit)

    return {"tags": cloud}


@router.post(
    "",
    response_model=TagResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new tag",
)
async def create_tag(
    tag_data: TagCreate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
) -> dict[str, Any]:
    """Create a new tag.

    Requires authentication.
    """
    service = TagService(db)

    try:
        tag = await service.create_tag(tag_data)
        await db.commit()
        return tag_to_response(tag)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(e),
        )


@router.get(
    "/{tag_id}",
    response_model=TagResponse,
    summary="Get tag by ID",
)
async def get_tag(
    tag_id: int,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Get a tag by ID.

    This endpoint is publicly accessible.
    """
    service = TagService(db)
    tag = await service.get_tag_by_id(tag_id)

    if not tag:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tag not found",
        )

    return tag_to_response(tag)


@router.get(
    "/slug/{slug}",
    response_model=TagResponse,
    summary="Get tag by slug",
)
async def get_tag_by_slug(
    slug: str,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Get a tag by slug.

    This endpoint is publicly accessible.
    """
    service = TagService(db)
    tag = await service.get_tag_by_slug(slug)

    if not tag:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tag not found",
        )

    return tag_to_response(tag)


@router.put(
    "/{tag_id}",
    response_model=TagResponse,
    summary="Update a tag",
)
async def update_tag(
    tag_id: int,
    tag_data: TagUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
) -> dict[str, Any]:
    """Update a tag.

    Requires authentication.
    """
    service = TagService(db)

    try:
        tag = await service.update_tag(tag_id, tag_data)
        if not tag:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Tag not found",
            )
        await db.commit()
        return tag_to_response(tag)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(e),
        )


@router.post(
    "/{tag_id}/reorder",
    response_model=TagResponse,
    summary="Reorder a tag",
)
async def reorder_tag(
    tag_id: int,
    reorder_data: TagReorder,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
) -> dict[str, Any]:
    """Reorder a tag relative to another tag.

    Requires authentication.
    """
    service = TagService(db)

    tag = await service.reorder_tag(
        tag_id=tag_id,
        target_id=reorder_data.target_id,
        position=reorder_data.position,
        current_parent_id=reorder_data.current_parent_id,
    )

    if not tag:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tag not found",
        )

    await db.commit()
    return tag_to_response(tag)


@router.delete(
    "/{tag_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a tag",
)
async def delete_tag(
    tag_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
) -> None:
    """Delete a tag.

    This removes the tag and its associations with posts.
    Requires authentication.
    """
    service = TagService(db)
    deleted = await service.delete_tag(tag_id)

    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tag not found",
        )

    await db.commit()


@router.get(
    "/{slug}/posts",
    response_model=TagWithPostsResponse,
    summary="Get posts by tag",
)
async def get_posts_by_tag(
    slug: str,
    page: int = Query(default=1, ge=1, description="Page number"),
    per_page: int | None = Query(default=None, ge=1, le=100, description="Items per page (defaults to posts_per_page setting)"),
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
) -> dict[str, Any]:
    """Get posts with a specific tag.

    Returns only published posts for unauthenticated users.
    Authenticated users see all posts.
    """
    service = TagService(db)
    settings_service = SettingsService(db)
    tag = await service.get_tag_by_slug(slug)

    if not tag:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tag not found",
        )

    all_settings = await settings_service.get_all_settings()
    effective_per_page = per_page or int(all_settings.get("posts_per_page", 10))

    published_only = current_user is None
    posts, total = await service.get_posts_by_tag(
        tag_id=tag.id,
        page=page,
        per_page=effective_per_page,
        published_only=published_only,
        recursive=True,
    )

    pages = math.ceil(total / effective_per_page) if total > 0 else 1

    return {
        "id": tag.id,
        "name": tag.name,
        "slug": tag.slug,
        "description": tag.description,
        "custom_url": tag.custom_url,
        "is_important": tag.is_important,
        "is_featured": tag.is_featured,
        "is_hidden": tag.is_hidden,
        "is_hidden_posts": tag.is_hidden_posts,
        "include_in_breadcrumbs": tag.include_in_breadcrumbs,
        "post_count": tag.post_count,
        "created_at": tag.created_at,
        "posts": [
            {
                "id": p.id,
                "title": p.title,
                "slug": p.slug,
                "excerpt": p.excerpt,
                "published_at": p.published_at,
                "thumbnail_path": p.thumbnail_path,
            }
            for p in posts
        ],
        "total_posts": total,
        "page": page,
        "per_page": effective_per_page,
        "pages": pages,
    }


@router.post(
    "/recalculate-counts",
    status_code=status.HTTP_200_OK,
    summary="Recalculate all tag post counts",
)
async def recalculate_counts(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
) -> dict[str, str]:
    """Recalculate post counts for all tags.

    Useful for fixing count inconsistencies.
    Requires authentication.
    """
    service = TagService(db)
    await service.update_all_post_counts()
    await db.commit()

    return {"message": "Tag counts recalculated successfully"}
