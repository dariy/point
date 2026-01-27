"""Public frontend routes.

Handles public-facing HTML pages for the blog.
"""

import logging
from datetime import datetime
from email.utils import format_datetime
from math import ceil
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, Response
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import get_settings
from app.database import get_db
from app.models.post import Post, PostStatus
from app.models.post_tag import post_tags
from app.models.tag import Tag
from app.services.cache_service import get_cache
from app.services.settings_service import SettingsService
from app.services.tag_service import TagService
from app.utils.formatters import (
    extract_all_images,
    format_content,
    generate_excerpt,
    strip_html,
    truncate_paragraphs,
)

settings = get_settings()
logger = logging.getLogger(__name__)


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
        "format_content": format_content,
        "truncate_paragraphs": truncate_paragraphs,
        "generate_excerpt": generate_excerpt,
    }


async def get_db_context(
    db: AsyncSession, blog_settings: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Get common database-dependent context variables.

    Args:
        db: Database session
        blog_settings: Optional pre-fetched blog settings

    Returns:
        Dictionary with tag_cloud, tags, and blog_settings
    """
    # Get tag cloud
    tag_service = TagService(db)
    tag_cloud = await tag_service.get_tag_cloud(limit=15)

    # Get tags for navigation
    tags_result = await db.execute(
        select(Tag).where(Tag.post_count > 0).order_by(Tag.name).limit(10)
    )
    tags = list(tags_result.scalars().all())

    # Get blog settings if not provided
    if blog_settings is None:
        settings_service = SettingsService(db)
        blog_settings = await settings_service.get_all_settings()

    context = {
        "tag_cloud": tag_cloud,
        "tags": tags,
        "blog_settings": blog_settings,
    }

    # Override common context with DB settings if available
    if "blog_title" in blog_settings:
        context["blog_title"] = blog_settings["blog_title"]
    if "blog_subtitle" in blog_settings:
        context["blog_subtitle"] = blog_settings["blog_subtitle"]
    if "author_name" in blog_settings:
        context["author_name"] = blog_settings["author_name"]

    return context


def serialize_post(post: Post) -> dict[str, Any]:
    """Serialize post for JSON response."""
    pub_date = post.published_at or post.created_at
    has_image = post.thumbnail_path is not None
    
    excerpt = post.excerpt
    preview_html = None
    
    if not excerpt:
        # Generate generic excerpt
        if has_image:
             excerpt = generate_excerpt(post.content, post.formatter.value, 200)
        else:
             content_html = format_content(post.content, post.formatter.value)
             preview_html = truncate_paragraphs(content_html)
    
    return {
        "title": post.title,
        "slug": post.slug,
        "thumbnail_path": post.thumbnail_path,
        "published_date": pub_date.strftime('%B %d, %Y'),
        "published_iso": pub_date.isoformat(),
        "view_count": post.view_count,
        "tags": [{"name": t.name, "slug": t.slug} for t in post.tags],
        "excerpt": excerpt,
        "preview_html": preview_html,
        "has_image": has_image,
        "is_featured": post.is_featured,
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
    # Check cache if enabled
    if settings.cache_enabled:
        cache = await get_cache()
        query_params = {"page": page} if page > 1 else None
        cached = await cache.get_by_url("/", query_params)
        # Skip cache for AJAX requests as they need JSON
        if cached and request.headers.get("X-Requested-With") != "XMLHttpRequest":
            logger.debug("Cache hit for homepage page=%d", page)
            return HTMLResponse(
                content=cached.content,
                headers={"X-Cache": "HIT"},
            )

    # Get blog settings early for pagination
    settings_service = SettingsService(db)
    blog_settings = await settings_service.get_all_settings()
    
    per_page = blog_settings.get("posts_per_page", 10)
    offset = (page - 1) * per_page

    # Get published posts with tags
    query = (
        select(Post)
        .options(selectinload(Post.tags))
        .where(Post.status == PostStatus.PUBLISHED)
        .order_by(Post.published_at.desc())
    )

    # Get total count
    count_query = select(func.count()).select_from(query.subquery())
    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0
    total_pages = ceil(total / per_page)

    # Get paginated posts
    posts_result = await db.execute(query.offset(offset).limit(per_page))
    posts = list(posts_result.scalars().all())

    # Check for AJAX request
    if request.headers.get("X-Requested-With") == "XMLHttpRequest":
        posts_data = [serialize_post(p) for p in posts]
        return JSONResponse(
            {
                "posts": posts_data,
                "pagination": {
                    "page": page,
                    "total_pages": total_pages,
                    "has_next": page < total_pages,
                    "has_prev": page > 1,
                    "next_page": page + 1,
                    "prev_page": page - 1,
                },
            }
        )

    # Get recent posts for sidebar
    recent_query = (
        select(Post)
        .where(Post.status == PostStatus.PUBLISHED)
        .order_by(Post.published_at.desc())
        .limit(5)
    )
    recent_result = await db.execute(recent_query)
    recent_posts = list(recent_result.scalars().all())

    context = get_common_context(request)
    db_context = await get_db_context(db, blog_settings)
    context.update(db_context)

    context.update(
        {
            "posts": posts,
            "page": page,
            "total_pages": total_pages,
            "total": total,
            "recent_posts": recent_posts,
        }
    )

    response = templates.TemplateResponse("public/index.html", context)

    # Store in cache if enabled
    if settings.cache_enabled and request.headers.get("X-Requested-With") != "XMLHttpRequest":
        cache = await get_cache()
        query_params = {"page": page} if page > 1 else None
        # Get rendered content
        content = response.body.decode("utf-8")
        await cache.set_by_url(
            "/",
            content,
            query_params,
            ttl=settings.cache_ttl_homepage,
        )
        response.headers["X-Cache"] = "MISS"

    return response


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

    # Always increment view count (even if we return cached content)
    post.view_count = (post.view_count or 0) + 1
    await db.commit()

    # Check cache if enabled (after incrementing view count)
    cache_key = f"/posts/{slug}"
    if settings.cache_enabled:
        cache = await get_cache()
        cached = await cache.get_by_url(cache_key)
        if cached:
            logger.debug("Cache hit for post slug=%s", slug)
            return HTMLResponse(
                content=cached.content,
                headers={"X-Cache": "HIT"},
            )

    # Format content
    content_html = format_content(post.content, post.formatter.value)

    # Check if post has text content (ignoring images and whitespace)
    # strip_html removes all tags including <img>, so we just check if any text remains
    text_content = strip_html(content_html)
    has_text_content = bool(text_content and text_content.strip())

    # Extract images for carousel
    post_images = extract_all_images(post.content)
    # If thumbnail exists and is not in content images, add it to the start
    if post.thumbnail_path:
        # Normalize thumbnail path for comparison (assuming standard media path)
        thumb_path_full = f"/media/originals/{post.thumbnail_path}"
        if (
            post.thumbnail_path not in post_images
            and thumb_path_full not in post_images
        ):
            post_images.insert(0, post.thumbnail_path)
    elif not post_images and post.thumbnail_path:
        post_images = [post.thumbnail_path]

    prev_post = None
    next_post = None

    if post.published_at:
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

    context = get_common_context(request)
    db_context = await get_db_context(db)
    context.update(db_context)

    context.update(
        {
            "post": post,
            "content_html": content_html,
            "has_text_content": has_text_content,
            "post_images": post_images,
            "prev_post": prev_post,
            "next_post": next_post,
        }
    )

    response = templates.TemplateResponse("public/post.html", context)

    # Store in cache if enabled
    if settings.cache_enabled:
        cache = await get_cache()
        content = response.body.decode("utf-8")
        await cache.set_by_url(
            cache_key,
            content,
            ttl=settings.cache_ttl_post,
        )
        response.headers["X-Cache"] = "MISS"

    return response


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
    # Check cache if enabled
    cache_key = f"/tag/{slug}"
    if settings.cache_enabled:
        cache = await get_cache()
        query_params = {"page": page} if page > 1 else None
        cached = await cache.get_by_url(cache_key, query_params)
        # Skip cache for AJAX requests
        if cached and request.headers.get("X-Requested-With") != "XMLHttpRequest":
            logger.debug("Cache hit for tag slug=%s page=%d", slug, page)
            return HTMLResponse(
                content=cached.content,
                headers={"X-Cache": "HIT"},
            )

    # Get the tag
    tag_result = await db.execute(select(Tag).where(Tag.slug == slug))
    tag = tag_result.scalar_one_or_none()

    if not tag:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tag not found",
        )

    # Get blog settings early for pagination
    settings_service = SettingsService(db)
    blog_settings = await settings_service.get_all_settings()
    
    per_page = blog_settings.get("posts_per_page", 12)
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

    # Check for AJAX request
    if request.headers.get("X-Requested-With") == "XMLHttpRequest":
        posts_data = [serialize_post(p) for p in posts]
        return JSONResponse(
            {
                "posts": posts_data,
                "pagination": {
                    "page": page,
                    "total_pages": total_pages,
                    "has_next": page < total_pages,
                    "has_prev": page > 1,
                    "next_page": page + 1,
                    "prev_page": page - 1,
                },
                "tag": {"name": tag.name, "slug": tag.slug},
            }
        )

    context = get_common_context(request)
    db_context = await get_db_context(db, blog_settings)
    context.update(db_context)

    context.update(
        {
            "tag": tag,
            "posts": posts,
            "page": page,
            "total_pages": total_pages,
            "total": total,
        }
    )

    response = templates.TemplateResponse("public/tag.html", context)

    # Store in cache if enabled
    if settings.cache_enabled and request.headers.get("X-Requested-With") != "XMLHttpRequest":
        cache = await get_cache()
        query_params = {"page": page} if page > 1 else None
        content = response.body.decode("utf-8")
        await cache.set_by_url(
            cache_key,
            content,
            query_params,
            ttl=settings.cache_ttl_tag,
        )
        response.headers["X-Cache"] = "MISS"

    return response


@router.get("/tags", response_class=HTMLResponse)
@router.get("/tags/{tag_slug}", response_class=HTMLResponse)
async def tags_page(
    request: Request,
    tag_slug: str | None = None,
    page: int = 1,
    db: AsyncSession = Depends(get_db),
) -> HTMLResponse:
    """Render the tags page (formerly gallery).

    Args:
        request: The current request
        tag_slug: Optional tag slug from path
        page: Page number for pagination
        db: Database session

    Returns:
        Rendered gallery HTML
    """
    # Get blog settings early for pagination
    settings_service = SettingsService(db)
    blog_settings = await settings_service.get_all_settings()
    
    per_page = blog_settings.get("posts_per_page", 24)
    offset = (page - 1) * per_page

    # Base query for published posts
    query = (
        select(Post)
        .options(selectinload(Post.tags))
        .where(Post.status == PostStatus.PUBLISHED)
    )

    # Filter by tag if provided
    if tag_slug:
        tag_result = await db.execute(select(Tag).where(Tag.slug == tag_slug))
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
        select(Tag).where(Tag.post_count > 0).order_by(Tag.name)
    )
    all_tags = list(tags_result.scalars().all())

    # Check for AJAX request
    if request.headers.get("X-Requested-With") == "XMLHttpRequest":
        posts_data = []
        for post in posts:
            pub_date = post.published_at or post.created_at

            # Calculate preview data
            has_image = post.thumbnail_path is not None
            excerpt = None
            preview_html = None

            if has_image:
                excerpt = post.excerpt or generate_excerpt(
                    post.content, post.formatter.value, 150
                )
            else:
                # Text-only preview
                content_html = format_content(post.content, post.formatter.value)
                preview_html = truncate_paragraphs(content_html)

            posts_data.append(
                {
                    "title": post.title,
                    "slug": post.slug,
                    "thumbnail_path": post.thumbnail_path,
                    "published_date": pub_date.strftime("%B %d, %Y"),
                    "view_count": post.view_count,
                    "tags": [{"name": t.name, "slug": t.slug} for t in post.tags],
                    "excerpt": excerpt,
                    "preview_html": preview_html,
                    "has_image": has_image,
                }
            )

        return JSONResponse(
            {
                "posts": posts_data,
                "pagination": {
                    "page": page,
                    "total_pages": total_pages,
                    "has_next": page < total_pages,
                    "has_prev": page > 1,
                    "next_page": page + 1,
                    "prev_page": page - 1,
                },
                "current_tag": tag_slug,
            }
        )

    context = get_common_context(request)
    db_context = await get_db_context(db, blog_settings)
    context.update(db_context)

    context.update(
        {
            "posts": posts,
            "page": page,
            "total_pages": total_pages,
            "total": total,
            "tags": all_tags,
            "current_tag": tag_slug,
        }
    )

    return templates.TemplateResponse("public/tags.html", context)


def get_base_url(request: Request) -> str:
    """Get the base URL from the request.

    Args:
        request: The current request

    Returns:
        Base URL string (scheme://host)
    """
    return f"{request.url.scheme}://{request.url.netloc}"


@router.get("/feed.xml", response_class=Response)
async def rss_feed(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Generate RSS feed.

    Args:
        request: The current request
        db: Database session

    Returns:
        RSS XML feed
    """
    # Check cache if enabled
    if settings.cache_enabled:
        cache = await get_cache()
        cached = await cache.get_by_url("/feed.xml", cache_type="feeds")
        if cached:
            logger.debug("Cache hit for RSS feed")
            return Response(
                content=cached.content,
                media_type="application/rss+xml; charset=utf-8",
                headers={
                    "Cache-Control": f"public, max-age={settings.cache_ttl_feed}",
                    "X-Cache": "HIT",
                },
            )

    # Get last 20 published posts
    query = (
        select(Post)
        .options(selectinload(Post.tags))
        .where(Post.status == PostStatus.PUBLISHED)
        .order_by(Post.published_at.desc())
        .limit(20)
    )
    result = await db.execute(query)
    posts = list(result.scalars().all())

    # Prepare post data with formatted content and dates
    posts_data = []
    for post in posts:
        pub_date = post.published_at or post.created_at
        posts_data.append(
            {
                "title": post.title,
                "slug": post.slug,
                "excerpt": post.excerpt,
                "meta_description": post.meta_description,
                "content_html": format_content(post.content, post.formatter.value),
                "thumbnail_path": post.thumbnail_path,
                "tags": post.tags,
                "pub_date_rfc822": format_datetime(pub_date),
            }
        )

    # Get build date
    build_date = format_datetime(datetime.now())

    base_url = get_base_url(request)

    context = {
        "request": request,
        "blog_title": settings.app_name,
        "blog_subtitle": getattr(settings, "blog_subtitle", ""),
        "author_name": getattr(settings, "author_name", "Admin"),
        "author_email": getattr(settings, "author_email", ""),
        "language": getattr(settings, "default_language", "en"),
        "base_url": base_url,
        "build_date": build_date,
        "posts": posts_data,
        "include_full_content": True,
    }

    content = templates.get_template("public/rss.xml").render(context)

    # Store in cache if enabled
    if settings.cache_enabled:
        cache = await get_cache()
        await cache.set_by_url(
            "/feed.xml",
            content,
            ttl=settings.cache_ttl_feed,
            content_type="application/rss+xml",
            cache_type="feeds",
        )

    return Response(
        content=content,
        media_type="application/rss+xml; charset=utf-8",
        headers={
            "Cache-Control": f"public, max-age={settings.cache_ttl_feed}",
            "X-Cache": "MISS",
        },
    )


@router.get("/sitemap.xml", response_class=Response)
async def sitemap(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Generate sitemap XML.

    Args:
        request: The current request
        db: Database session

    Returns:
        Sitemap XML
    """
    # Check cache if enabled
    if settings.cache_enabled:
        cache = await get_cache()
        cached = await cache.get_by_url("/sitemap.xml", cache_type="feeds")
        if cached:
            logger.debug("Cache hit for sitemap")
            return Response(
                content=cached.content,
                media_type="application/xml; charset=utf-8",
                headers={
                    "Cache-Control": f"public, max-age={settings.cache_ttl_sitemap}",
                    "X-Cache": "HIT",
                },
            )

    # Get all published posts
    posts_query = (
        select(Post)
        .where(Post.status == PostStatus.PUBLISHED)
        .order_by(Post.published_at.desc())
    )
    posts_result = await db.execute(posts_query)
    posts = list(posts_result.scalars().all())

    # Format posts with lastmod
    posts_data = []
    for post in posts:
        lastmod = post.updated_at or post.published_at or post.created_at
        posts_data.append(
            {
                "slug": post.slug,
                "lastmod": lastmod.strftime("%Y-%m-%d"),
            }
        )

    # Get all tags with posts
    tags_query = select(Tag).where(Tag.post_count > 0).order_by(Tag.name)
    tags_result = await db.execute(tags_query)
    tags = list(tags_result.scalars().all())

    # Last updated date
    last_updated = datetime.now().strftime("%Y-%m-%d")

    base_url = get_base_url(request)

    context = {
        "request": request,
        "base_url": base_url,
        "posts": posts_data,
        "tags": tags,
        "last_updated": last_updated,
    }

    content = templates.get_template("public/sitemap.xml").render(context)

    # Store in cache if enabled
    if settings.cache_enabled:
        cache = await get_cache()
        await cache.set_by_url(
            "/sitemap.xml",
            content,
            ttl=settings.cache_ttl_sitemap,
            content_type="application/xml",
            cache_type="feeds",
        )

    return Response(
        content=content,
        media_type="application/xml; charset=utf-8",
        headers={
            "Cache-Control": f"public, max-age={settings.cache_ttl_sitemap}",
            "X-Cache": "MISS",
        },
    )


@router.get("/robots.txt", response_class=PlainTextResponse)
async def robots_txt(request: Request) -> PlainTextResponse:
    """Generate robots.txt.

    Args:
        request: The current request

    Returns:
        robots.txt content
    """
    base_url = get_base_url(request)

    content = f"""# robots.txt for {settings.app_name}
User-agent: *
Allow: /
Disallow: /admin/
Disallow: /api/
Disallow: /preview/

# Sitemap
Sitemap: {base_url}/sitemap.xml
"""
    return PlainTextResponse(
        content=content,
        headers={"Cache-Control": "public, max-age=86400"},
    )
