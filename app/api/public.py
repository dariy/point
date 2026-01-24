"""Public frontend routes.

Handles public-facing HTML pages for the blog.
"""

from datetime import datetime
from math import ceil
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import get_settings
from app.database import get_db
from app.models.post import Post, PostStatus
from app.models.post_tag import post_tags
from app.models.tag import Tag
from app.services.tag_service import TagService
from app.utils.formatters import format_content

settings = get_settings()

# Set up templates
templates_dir = Path(__file__).parent.parent / "templates"
templates = Jinja2Templates(directory=str(templates_dir))

router = APIRouter(tags=["Public"])


def get_common_context(request: Request) -> dict[str, Any]:
    """Get common template context variables.

    Args:
        request: The current request

    Returns:
        Dictionary with common context variables
    """
    return {
        "request": request,
        "blog_title": settings.app_name,
        "blog_subtitle": getattr(settings, "blog_subtitle", ""),
        "author_name": getattr(settings, "author_name", "Admin"),
        "current_year": datetime.now().year,
    }


@router.get("/", response_class=HTMLResponse)
async def homepage(
    request: Request,
    page: int = 1,
    db: AsyncSession = Depends(get_db),
) -> HTMLResponse:
    """Render the homepage with paginated posts.

    Args:
        request: The current request
        page: Page number for pagination
        db: Database session

    Returns:
        Rendered homepage HTML
    """
    per_page = 10
    offset = (page - 1) * per_page

    # Get published posts with tags
    query = (
        select(Post)
        .options(selectinload(Post.tags))
        .where(Post.status == PostStatus.PUBLISHED)
        .order_by(Post.published_at.desc())
    )

    # Get total count
    count_query = select(func.count()).select_from(
        query.subquery()
    )
    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0
    total_pages = ceil(total / per_page)

    # Get paginated posts
    posts_result = await db.execute(
        query.offset(offset).limit(per_page)
    )
    posts = list(posts_result.scalars().all())

    # Get tag cloud
    tag_service = TagService(db)
    tag_cloud = await tag_service.get_tag_cloud(limit=15)

    # Get recent posts for sidebar
    recent_query = (
        select(Post)
        .where(Post.status == PostStatus.PUBLISHED)
        .order_by(Post.published_at.desc())
        .limit(5)
    )
    recent_result = await db.execute(recent_query)
    recent_posts = list(recent_result.scalars().all())

    # Get tags for navigation
    tags_result = await db.execute(
        select(Tag)
        .where(Tag.post_count > 0)
        .order_by(Tag.name)
        .limit(10)
    )
    tags = list(tags_result.scalars().all())

    context = get_common_context(request)
    context.update({
        "posts": posts,
        "page": page,
        "total_pages": total_pages,
        "total": total,
        "tag_cloud": tag_cloud,
        "recent_posts": recent_posts,
        "tags": tags,
    })

    return templates.TemplateResponse("public/index.html", context)


@router.get("/posts/{slug}", response_class=HTMLResponse)
async def single_post(
    request: Request,
    slug: str,
    db: AsyncSession = Depends(get_db),
) -> HTMLResponse:
    """Render a single post page.

    Args:
        request: The current request
        slug: Post slug
        db: Database session

    Returns:
        Rendered post HTML

    Raises:
        HTTPException: If post not found
    """
    # Get post with tags
    query = (
        select(Post)
        .options(selectinload(Post.tags))
        .where(Post.slug == slug)
        .where(Post.status == PostStatus.PUBLISHED)
    )
    result = await db.execute(query)
    post = result.scalar_one_or_none()

    if not post:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Post not found",
        )

    # Increment view count
    post.view_count = (post.view_count or 0) + 1
    await db.commit()

    # Format content
    content_html = format_content(post.content, post.formatter.value)

    # Get previous post
    prev_query = (
        select(Post)
        .where(Post.status == PostStatus.PUBLISHED)
        .where(Post.published_at < post.published_at)
        .order_by(Post.published_at.desc())
        .limit(1)
    )
    prev_result = await db.execute(prev_query)
    prev_post = prev_result.scalar_one_or_none()

    # Get next post
    next_query = (
        select(Post)
        .where(Post.status == PostStatus.PUBLISHED)
        .where(Post.published_at > post.published_at)
        .order_by(Post.published_at.asc())
        .limit(1)
    )
    next_result = await db.execute(next_query)
    next_post = next_result.scalar_one_or_none()

    # Get tags for navigation
    tags_result = await db.execute(
        select(Tag)
        .where(Tag.post_count > 0)
        .order_by(Tag.name)
        .limit(10)
    )
    tags = list(tags_result.scalars().all())

    context = get_common_context(request)
    context.update({
        "post": post,
        "content_html": content_html,
        "prev_post": prev_post,
        "next_post": next_post,
        "tags": tags,
    })

    return templates.TemplateResponse("public/post.html", context)


@router.get("/tag/{slug}", response_class=HTMLResponse)
async def tag_archive(
    request: Request,
    slug: str,
    page: int = 1,
    db: AsyncSession = Depends(get_db),
) -> HTMLResponse:
    """Render a tag archive page.

    Args:
        request: The current request
        slug: Tag slug
        page: Page number for pagination
        db: Database session

    Returns:
        Rendered tag archive HTML

    Raises:
        HTTPException: If tag not found
    """
    # Get the tag
    tag_result = await db.execute(select(Tag).where(Tag.slug == slug))
    tag = tag_result.scalar_one_or_none()

    if not tag:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tag not found",
        )

    per_page = 12
    offset = (page - 1) * per_page

    # Get posts with this tag
    tag_service = TagService(db)
    posts, total = await tag_service.get_posts_by_tag(
        tag_id=tag.id,
        page=page,
        per_page=per_page,
        published_only=True,
    )

    total_pages = ceil(total / per_page)

    # Load tags for each post
    for post in posts:
        await db.refresh(post, ["tags"])

    # Get tags for navigation
    tags_result = await db.execute(
        select(Tag)
        .where(Tag.post_count > 0)
        .order_by(Tag.name)
        .limit(10)
    )
    tags = list(tags_result.scalars().all())

    context = get_common_context(request)
    context.update({
        "tag": tag,
        "posts": posts,
        "page": page,
        "total_pages": total_pages,
        "total": total,
        "tags": tags,
    })

    return templates.TemplateResponse("public/tag.html", context)


@router.get("/gallery", response_class=HTMLResponse)
async def gallery(
    request: Request,
    page: int = 1,
    tag: str | None = None,
    db: AsyncSession = Depends(get_db),
) -> HTMLResponse:
    """Render the gallery page.

    Args:
        request: The current request
        page: Page number for pagination
        tag: Optional tag filter
        db: Database session

    Returns:
        Rendered gallery HTML
    """
    per_page = 24
    offset = (page - 1) * per_page

    # Base query for published posts with thumbnails
    query = (
        select(Post)
        .options(selectinload(Post.tags))
        .where(Post.status == PostStatus.PUBLISHED)
        .where(Post.thumbnail_path.isnot(None))
    )

    # Filter by tag if provided
    if tag:
        tag_result = await db.execute(select(Tag).where(Tag.slug == tag))
        tag_obj = tag_result.scalar_one_or_none()

        if tag_obj:
            query = query.join(post_tags).where(post_tags.c.tag_id == tag_obj.id)

    query = query.order_by(Post.published_at.desc())

    # Get total count
    count_query = select(func.count()).select_from(query.subquery())
    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0
    total_pages = ceil(total / per_page)

    # Get paginated posts
    posts_result = await db.execute(query.offset(offset).limit(per_page))
    posts = list(posts_result.scalars().all())

    # Get all tags with posts for filter
    tags_result = await db.execute(
        select(Tag)
        .where(Tag.post_count > 0)
        .order_by(Tag.name)
    )
    all_tags = list(tags_result.scalars().all())

    context = get_common_context(request)
    context.update({
        "posts": posts,
        "page": page,
        "total_pages": total_pages,
        "total": total,
        "tags": all_tags,
        "current_tag": tag,
    })

    return templates.TemplateResponse("public/gallery.html", context)
