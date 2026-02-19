"""Compound page-data endpoints for the SPA frontend.

Each endpoint returns all the data needed to render a complete page in a
single round-trip, reducing latency during client-side navigation.

All endpoints are public (no authentication required) and return only
published, non-hidden content.
"""

import math
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.posts import post_to_response
from app.api.tags import tag_to_list_item, tag_to_response
from app.database import get_db
from app.services.post_service import PostService
from app.services.settings_service import SettingsService
from app.services.tag_service import TagService

router = APIRouter(prefix="/api/pages", tags=["Pages"])

# Public settings keys exposed on the home page
_PUBLIC_SETTING_KEYS = frozenset({
    "blog_title",
    "blog_subtitle",
    "author_name",
    "posts_per_page",
    "default_theme",
    "show_view_counts",
    "use_thumbnails",
    "about_post_id",
})


@router.get(
    "/home",
    summary="Homepage data",
    description=(
        "Returns all data needed to render the public homepage in a single request: "
        "paginated published posts, featured tag cloud, and public blog settings."
    ),
    tags=["Pages", "Public"],
)
async def get_home_page(
    page: int = Query(default=1, ge=1, description="Page number"),
    per_page: int = Query(default=10, ge=1, le=100, description="Posts per page"),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Get homepage data: published posts + tag cloud + public settings."""
    post_service = PostService(db)
    tag_service = TagService(db)
    settings_service = SettingsService(db)

    # Load in parallel via separate awaits (SQLite is sequential anyway)
    posts, total = await post_service.list_posts(
        page=page,
        per_page=per_page,
        include_drafts=False,
        public_only=True,
    )

    tag_cloud = await tag_service.get_tag_cloud(limit=20, featured=True)

    all_settings = await settings_service.get_all_settings()
    public_settings = {k: v for k, v in all_settings.items() if k in _PUBLIC_SETTING_KEYS}

    pages = math.ceil(total / per_page) if total > 0 else 1

    return {
        "posts": [post_to_response(p, post_service, include_content=False) for p in posts],
        "pagination": {
            "page": page,
            "per_page": per_page,
            "total": total,
            "pages": pages,
        },
        "tag_cloud": tag_cloud,
        "settings": public_settings,
    }


@router.get(
    "/tag/{slug}",
    summary="Tag page data",
    description=(
        "Returns all data needed to render a tag archive page: the tag itself, "
        "its ancestor breadcrumb trail, and paginated published posts for that tag "
        "(including posts from all descendant tags)."
    ),
    tags=["Pages", "Public"],
)
async def get_tag_page(
    slug: str,
    page: int = Query(default=1, ge=1, description="Page number"),
    per_page: int = Query(default=10, ge=1, le=100, description="Posts per page"),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Get tag archive page data: tag + ancestor breadcrumbs + posts."""
    tag_service = TagService(db)
    post_service = PostService(db)

    tag = await tag_service.get_tag_by_slug(slug)
    if not tag:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tag '{slug}' not found",
        )

    # Ancestors from root → self, for breadcrumb rendering
    hierarchy = await tag_service.get_tag_hierarchy(tag.id)

    posts, total = await tag_service.get_posts_by_tag(
        tag_id=tag.id,
        page=page,
        per_page=per_page,
        published_only=True,
        recursive=True,
        public_only=True,
    )

    pages = math.ceil(total / per_page) if total > 0 else 1

    return {
        "tag": tag_to_response(tag),
        "breadcrumbs": [tag_to_list_item(t) for t in hierarchy],
        "posts": [post_to_response(p, post_service, include_content=False) for p in posts],
        "pagination": {
            "page": page,
            "per_page": per_page,
            "total": total,
            "pages": pages,
        },
    }


@router.get(
    "/tags",
    summary="Tags directory data",
    description=(
        "Returns all visible tags with post counts. "
        "Hidden tags are excluded. Tags include their parent/child relationships "
        "so the frontend can render a hierarchical directory."
    ),
    tags=["Pages", "Public"],
)
async def get_tags_page(
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Get tags directory page data: full tag list with hierarchy info."""
    tag_service = TagService(db)

    tags = await tag_service.list_tags(
        include_empty=False,
        public_only=True,
    )

    return {
        "tags": [tag_to_response(t) for t in tags],
        "total": len(tags),
    }
