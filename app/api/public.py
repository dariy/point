"""Public frontend routes.

Handles public-facing HTML pages for the blog.
"""

import logging
from datetime import UTC, datetime
from math import ceil
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, Response
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import get_settings
from app.database import get_db
from app.dependencies import get_current_user
from app.models.post import Post, PostStatus
from app.models.post_tag import post_tags
from app.models.tag import Tag
from app.models.user import User
from app.services.cache_service import get_cache
from app.services.settings_service import SettingsService
from app.services.tag_service import TagService
from app.utils.formatters import (
    determine_thumbnail,
    extract_all_media,
    format_content,
    generate_excerpt,
    strip_html,
    truncate_paragraphs,
)
from app.utils.template_helpers import (
    post_has_hidden_posts_tag,
    tag_has_hidden_parent,
    tag_has_hidden_posts_parent,
)

settings = get_settings()
logger = logging.getLogger(__name__)


# Set up templates
templates_dir = Path(__file__).parent.parent / "templates"
templates = Jinja2Templates(directory=str(templates_dir))

# Register template filters
templates.env.filters["tag_has_hidden_parent"] = tag_has_hidden_parent
templates.env.filters["tag_has_hidden_posts_parent"] = tag_has_hidden_posts_parent
templates.env.filters["post_has_hidden_posts_tag"] = post_has_hidden_posts_tag

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
        "author_name": getattr(settings, "author_name", "Light"),
        "current_year": datetime.now().year,
        "app_version": settings.app_version,
        "format_content": format_content,
        "truncate_paragraphs": truncate_paragraphs,
        "generate_excerpt": generate_excerpt,
        "determine_thumbnail": lambda c, t: determine_thumbnail(c, t, settings.storage_path, settings.use_thumbnails),
    }


async def get_db_context(
    db: AsyncSession, blog_settings: dict[str, Any] | None = None, user: User | None = None
) -> dict[str, Any]:
    """Get common database-dependent context variables.

    Args:
        db: Database session
        blog_settings: Optional pre-fetched blog settings
        user: Current user (optional) - if provided, hidden tags will be shown

    Returns:
        Dictionary with tag_cloud, tags, and blog_settings
    """
    # Get tag cloud
    tag_service = TagService(db)
    tag_cloud = await tag_service.get_tag_cloud(limit=15)

    # Get hidden tags to exclude (only for non-authenticated users)
    hidden_ids = set()
    if not user:
        hidden_ids = await tag_service.get_publicly_hidden_tag_ids()

    tags_query = (
        select(Tag)
        .where(Tag.is_featured)
        .where(Tag.post_count > 0)
    )
    if hidden_ids:
        tags_query = tags_query.where(Tag.id.notin_(hidden_ids))

    tags_result = await db.execute(tags_query.order_by(Tag.name).limit(20))
    tags = list(tags_result.scalars().all())

    # Force load attributes while in async context to avoid lazy loading issues
    for tag in tags:
        _ = tag.id
        _ = tag.name
        _ = tag.slug
        _ = tag.is_hidden
        _ = tag.is_featured
        _ = tag.post_count

    # Get hierarchical tag groups for categories switcher
    tag_groups = await tag_service.get_hierarchical_tags(include_empty=False, public_only=(not user))

    # Get blog settings if not provided
    if blog_settings is None:
        settings_service = SettingsService(db)
        blog_settings = await settings_service.get_all_settings()

    context = {
        "tag_cloud": tag_cloud,
        "tags": tags,
        "tag_groups": tag_groups,
        "blog_settings": blog_settings,
    }

    # Override common context with DB settings if available
    if "blog_title" in blog_settings:
        context["blog_title"] = blog_settings["blog_title"]
    if "blog_subtitle" in blog_settings:
        context["blog_subtitle"] = blog_settings["blog_subtitle"]
    if "author_name" in blog_settings:
        context["author_name"] = blog_settings["author_name"]

    # Fetch about post if configured
    about_post_slug = None
    if "about_post_id" in blog_settings and blog_settings["about_post_id"]:
        try:
            about_post_result = await db.execute(
                select(Post).where(Post.id == blog_settings["about_post_id"])
            )
            about_post = about_post_result.scalar_one_or_none()
            if about_post:
                about_post_slug = about_post.slug
        except Exception as e:
            logger.warning("Failed to fetch about post: %s", e)

    context["about_post_slug"] = about_post_slug

    return context


def serialize_post(
    post: Post,
    publicly_hidden_tag_ids: set[int] | None = None,
    use_thumbnails: bool = True
) -> dict[str, Any]:
    """Serialize post for JSON response.

    Args:
        post: Post to serialize
        publicly_hidden_tag_ids: Set of tag IDs to exclude from serialization (for non-authenticated users)
        use_thumbnails: Whether to use thumbnails
    """
    pub_date = post.published_at or post.created_at

    # Check for media
    media_list = extract_all_media(post.content)
    has_image = post.thumbnail_path is not None or any(m["type"] == "image" for m in media_list)
    has_video = any(m["type"] == "video" for m in media_list)
    has_media = has_image or has_video

    excerpt = post.excerpt
    preview_html = None

    if not excerpt:
        # Generate generic excerpt
        if has_media:
             excerpt = generate_excerpt(post.content, post.formatter, 200)
        else:
             content_html = format_content(post.content, post.formatter)
             preview_html = truncate_paragraphs(content_html)

    # logic for thumbnail:
    # 1. Use explicit post.thumbnail_path if it's not a video (by extension)
    # 2. Or use the first image from content
    # 3. Or use the first video as fallback

    thumb_path, is_video_thumb = determine_thumbnail(
        post.content,
        post.thumbnail_path,
        settings.storage_path,
        use_thumbnails
    )

    # Filter tags if publicly_hidden_tag_ids is provided
    if publicly_hidden_tag_ids is not None:
        visible_tags = [t for t in post.tags if t.id not in publicly_hidden_tag_ids]
    else:
        visible_tags = post.tags

    # Check if post has any tag with is_hidden_posts or parent with is_hidden_posts
    has_hidden_posts_tag = False
    for tag in post.tags:
        if tag.is_hidden_posts:
            has_hidden_posts_tag = True
            break
        if tag.parents and any(parent.is_hidden_posts for parent in tag.parents):
            has_hidden_posts_tag = True
            break

    return {
        "id": post.id,
        "title": post.title,
        "slug": post.slug,
        "thumbnail_path": thumb_path,
        "published_date": pub_date.strftime('%B %d, %Y'),
        "published_iso": pub_date.isoformat(),
        "view_count": post.view_count,
        "tags": [{"name": t.name, "slug": t.slug, "post_count": t.post_count} for t in visible_tags],
        "excerpt": excerpt,
        "preview_html": preview_html,
        "has_image": has_media, # Keep key name for frontend layout compatibility
        "is_video": is_video_thumb, # This specific thumbnail is a video
        "has_video": has_video, # The post contains at least one video
        "is_featured": post.is_featured,
        "has_hidden_posts_tag": has_hidden_posts_tag,
    }


@router.get("/", response_class=HTMLResponse)
async def homepage(
    request: Request,
    page: int = 1,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
) -> Response:
    """Render the homepage with paginated posts.

    Args:
        request: The current request
        page: Page number for pagination
        db: Database session
        user: Current user (optional)

    Returns:
        Rendered homepage HTML
    """
    # Check cache if enabled
    if settings.cache_enabled:
        cache = await get_cache()
        query_params = {"page": page} if page > 1 else None
        cached = await cache.get_by_url("/", query_params)
        # Skip cache for AJAX requests as they need JSON
        # Also skip cache if user is logged in to show edit buttons
        if cached and request.headers.get("X-Requested-With") != "XMLHttpRequest" and not user:
            logger.debug("Cache hit for homepage page=%d", page)
            return HTMLResponse(
                content=cached.content,
                headers={"X-Cache": "HIT"},
            )

    # Get blog settings early for pagination
    settings_service = SettingsService(db)
    blog_settings = await settings_service.get_all_settings()

    per_page = blog_settings.get("posts_per_page", 10)

    # Get hidden tags for posts
    tag_service = TagService(db)
    hidden_posts_tag_ids = await tag_service.get_hidden_posts_tag_ids()

    # Base query for posts
    query = (
        select(Post)
        .where(Post.status == PostStatus.PUBLISHED)
        .order_by(Post.published_at.desc().nulls_last(), Post.created_at.desc())
        .options(selectinload(Post.tags).selectinload(Tag.parents)) # Eager load tags and their parents
    )

    # Apply hidden posts filter if tags exist
    if hidden_posts_tag_ids:
        query = query.where(
            ~Post.tags.any(Tag.id.in_(hidden_posts_tag_ids))
        )

    # Find the latest featured post for the homepage
    featured_query = query.where(Post.is_featured.is_(True)).limit(1)
    featured_result = await db.execute(featured_query)
    featured_post = featured_result.scalar_one_or_none()
    first_post_is_featured = featured_post is not None

    # Adjust per_page and offset
    actual_per_page = per_page
    actual_offset = (page - 1) * per_page

    if featured_post:
        # Exclude the featured post from the main list
        query = query.where(Post.id != featured_post.id)
        # On page 1, we show featured + per_page posts.
        # On subsequent pages, we show per_page posts starting after (page-1)*per_page posts.
        # This is already handled by the default actual_offset and actual_per_page
        # but let's be explicit.
        actual_per_page = per_page
        actual_offset = (page - 1) * per_page

    # Count query - use a more explicit approach for many-to-many filtering
    if hidden_posts_tag_ids:
        # Count posts that don't have any of the hidden tags
        count_query = (
            select(func.count(Post.id.distinct()))
            .select_from(Post)
            .outerjoin(post_tags, Post.id == post_tags.c.post_id)
            .where(Post.status == PostStatus.PUBLISHED)
            .where(
                ~Post.id.in_(
                    select(post_tags.c.post_id).where(post_tags.c.tag_id.in_(hidden_posts_tag_ids))
                )
            )
        )
    else:
        # Simple count when no hidden tags
        count_query = (
            select(func.count(Post.id))
            .where(Post.status == PostStatus.PUBLISHED)
        )

    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0

    # Adjust total_pages calculation
    if first_post_is_featured and total > 0:
        total_pages = 1 + max(0, ceil((total - 1 - per_page) / per_page))
    else:
        total_pages = ceil(total / per_page)

    # Get paginated posts
    posts_result = await db.execute(query.offset(actual_offset).limit(actual_per_page))
    posts = list(posts_result.scalars().all())

    if page == 1 and featured_post:
        posts = [featured_post] + posts

    # Check for AJAX request
    if request.headers.get("X-Requested-With") == "XMLHttpRequest":
        logger.info("DEBUG: AJAX branch hit in homepage")
        # Get publicly hidden tag IDs for filtering if not authenticated
        tag_filter_ids = None if user else (await TagService(db).get_publicly_hidden_tag_ids())
        use_thumbs = blog_settings.get("use_thumbnails", True)
        posts_data = [serialize_post(p, tag_filter_ids, use_thumbs) for p in posts]
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
                "is_logged_in": user is not None,
            }
        )

    # Get recent posts for sidebar
    recent_query = (
        select(Post)
        .where(Post.status == PostStatus.PUBLISHED)
        .order_by(Post.published_at.desc().nulls_last(), Post.created_at.desc())
        .limit(5)
    )
    recent_result = await db.execute(recent_query)
    recent_posts = list(recent_result.scalars().all())

    context = get_common_context(request)
    db_context = await get_db_context(db, blog_settings, user)
    context.update(db_context)

    # Filter hidden tags from posts for non-authenticated users
    if not user:
        tag_service = TagService(db)
        publicly_hidden_tag_ids = await tag_service.get_publicly_hidden_tag_ids()
        for post in posts:
            post.tags = [t for t in post.tags if t.id not in publicly_hidden_tag_ids]
        for post in recent_posts:
            post.tags = [t for t in post.tags if t.id not in publicly_hidden_tag_ids]

    context.update(
        {
            "posts": posts,
            "page": page,
            "total_pages": total_pages,
            "total": total,
            "recent_posts": recent_posts,
            "user": user,
        }
    )

    response = templates.TemplateResponse("public/index.html", context)

    # Store in cache if enabled
    if settings.cache_enabled and request.headers.get("X-Requested-With") != "XMLHttpRequest" and not user:
        cache = await get_cache()
        query_params = {"page": page} if page > 1 else None
        # Get rendered content
        content = bytes(response.body).decode("utf-8")
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
    user: User | None = Depends(get_current_user),
) -> Response:
    """Render a single post page.

    Args:
        request: The current request
        slug: Post slug
        db: Database session
        user: Current user (optional)

    Returns:
        Rendered post HTML

    Raises:
        HTTPException: If post not found
    """
    # Get post with tags
    query = (
        select(Post)
        .where(Post.slug == slug)
        .where(
            or_(Post.status == PostStatus.PUBLISHED, Post.status == PostStatus.HIDDEN)
        )
    )
    result = await db.execute(query)
    post = result.scalar_one_or_none()
    if not post:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Post not found",
        )

    # Check if post has any hidden-posts tags if not author
    if not user:
        tag_service = TagService(db)
        hidden_posts_tag_ids = await tag_service.get_hidden_posts_tag_ids()
        if hidden_posts_tag_ids:
            # Check if any associated tag is in hidden_posts_tag_ids
            post_tag_ids_result = await db.execute(
                select(post_tags.c.tag_id).where(post_tags.c.post_id == post.id)
            )
            post_tag_ids = {row[0] for row in post_tag_ids_result.all()}
            if any(tid in hidden_posts_tag_ids for tid in post_tag_ids):
                 raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Post not found",
                )

    # Explicitly load relationships using awaitable_attrs to avoid MissingGreenlet
    try:
        await post.awaitable_attrs.tags
        await post.awaitable_attrs.author
        for tag in post.tags:
            await tag.awaitable_attrs.parents
            await tag.awaitable_attrs.children
    except Exception as e:
        logger.error("Error loading relationships for post %s: %s", slug, e)
        # Continue anyway, might still render partially

    # Increment view count
    post.view_count = (post.view_count or 0) + 1
    await db.flush()

    # Check cache if enabled (after incrementing view count)
    # Skip cache if user is logged in
    cache_key = f"/posts/{slug}"
    if settings.cache_enabled and not user:
        cache = await get_cache()
        cached = await cache.get_by_url(cache_key)
        if cached:
            logger.debug("Cache hit for post slug=%s", slug)
            return HTMLResponse(
                content=cached.content,
                headers={"X-Cache": "HIT"},
            )

    # Format content
    content_html = format_content(post.content, post.formatter)

    # Check if post has text content (ignoring images and whitespace)
    # strip_html removes all tags including <img>, so we just check if any text remains
    text_content = strip_html(content_html)
    has_text_content = bool(text_content and text_content.strip())

    # Extract all media for carousel
    post_media = extract_all_media(post.content)

    # Function to ensure we have an original URL
    async def ensure_original_url(url: str | None) -> str | None:
        if not url:
            return url
        if "/media/thumbnails/" in url:
            # Try to find corresponding media record to get original path
            rel_thumb_path = url.split("/media/", 1)[1]
            from app.models.media import Media
            result = await db.execute(select(Media).where(Media.thumbnail_path == rel_thumb_path))
            media = result.scalar_one_or_none()
            if media:
                return f"/media/{media.original_path}"
            # Fallback: just swap the directory and hope for the best (might fail if extensions differ)
            return url.replace("/thumbnails/", "/originals/")
        return url

    # Clean up post_media to use originals
    for item in post_media:
        original_url = await ensure_original_url(item["url"])
        if original_url:
            item["url"] = original_url

    # If thumbnail exists and is not in content media, add it to the start
    if post.thumbnail_path:
        thumb_url = await ensure_original_url(post.thumbnail_path)
        # Check if already present
        if thumb_url and not any(m["url"] == thumb_url for m in post_media):
            # Also check with full path
            thumb_path_full = f"/media/originals/{thumb_url}" if not thumb_url.startswith("/") else thumb_url
            if not any(m["url"] == thumb_path_full for m in post_media):
                post_media.insert(0, {"url": thumb_url, "type": "image"})
    elif not post_media and post.thumbnail_path:
        final_thumb_url = await ensure_original_url(post.thumbnail_path)
        if final_thumb_url:
            post_media = [{"url": final_thumb_url, "type": "image"}]

    prev_post = None
    next_post = None

    if post.status == PostStatus.PUBLISHED and post.published_at:
        # Get previous post
        prev_query = (
            select(Post)
            .where(Post.status == PostStatus.PUBLISHED)
            .where(Post.published_at < post.published_at)
            .order_by(Post.published_at.desc().nulls_last(), Post.created_at.desc())
            .limit(1)
        )
        prev_result = await db.execute(prev_query)
        prev_post = prev_result.scalar_one_or_none()

        # Get next post
        next_query = (
            select(Post)
            .where(Post.status == PostStatus.PUBLISHED)
            .where(Post.published_at > post.published_at)
            .order_by(Post.published_at.asc().nulls_last(), Post.created_at.asc())
            .limit(1)
        )
        next_result = await db.execute(next_query)
        next_post = next_result.scalar_one_or_none()

    # Get explicitly selected tags for the post
    tags = await post.awaitable_attrs.tags

    # Filter out hidden tags for non-authenticated users
    if not user:
        tag_service = TagService(db)
        publicly_hidden_tag_ids = await tag_service.get_publicly_hidden_tag_ids()
        all_post_tags = sorted(
            [t for t in tags if t.id not in publicly_hidden_tag_ids],
            key=lambda x: x.name
        )
    else:
        all_post_tags = sorted(tags, key=lambda x: x.name)

    # Check for AJAX request
    if request.headers.get("X-Requested-With") == "XMLHttpRequest":
        settings_service = SettingsService(db)
        blog_settings_dict = await settings_service.get_all_settings()

        # Ensure thumbnail_path in response is also original
        resolved_thumb = await ensure_original_url(post.thumbnail_path) if post.thumbnail_path else None

        return JSONResponse(
            {
                "post": {
                    "id": post.id,
                    "title": post.title,
                    "slug": post.slug,
                    "published_date": (post.published_at or post.created_at).strftime('%B %d, %Y'),
                    "published_iso": (post.published_at or post.created_at).isoformat(),
                    "view_count": post.view_count,
                    "content_html": content_html,
                    "thumbnail_path": resolved_thumb,
                    "tags": [{"name": t.name, "slug": t.slug, "post_count": t.post_count} for t in all_post_tags],
                },
                "has_text_content": has_text_content,
                "post_media": post_media,
                "prev_post": {"title": prev_post.title, "slug": prev_post.slug} if prev_post else None,
                "next_post": {"title": next_post.title, "slug": next_post.slug} if next_post else None,
                "blog_settings": {
                    "show_view_counts": blog_settings_dict.get("show_view_counts", True),
                    "enable_analytics": blog_settings_dict.get("enable_analytics", False),
                    "google_analytics_id": blog_settings_dict.get("google_analytics_id", "")
                },
                "blog_title": blog_settings_dict.get("blog_title", settings.app_name),
                "blog_subtitle": blog_settings_dict.get("blog_subtitle", getattr(settings, "blog_subtitle", "")),
                "is_logged_in": user is not None,
                "post_tags_with_parents": [], # Legacy, no longer used
            }
        )

    context = get_common_context(request)
    db_context = await get_db_context(db, user=user)
    context.update(db_context)

    context.update(
        {
            "post": post,
            "content_html": content_html,
            "has_text_content": has_text_content,
            "post_media": post_media,
            "prev_post": prev_post,
            "next_post": next_post,
            "user": user,
        }
    )

    response = templates.TemplateResponse("public/post.html", context)

    # Store in cache if enabled and not logged in
    if settings.cache_enabled and not user:
        cache = await get_cache()
        content = bytes(response.body).decode("utf-8")
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
    user: User | None = Depends(get_current_user),
) -> Response:
    """Render a tag archive page.

    Args:
        request: The current request
        slug: Tag slug
        page: Page number for pagination
        db: Database session
        user: Current user (optional)

    Returns:
        Rendered tag archive HTML

    Raises:
        HTTPException: If tag not found
    """
    # Check cache if enabled
    cache_key = f"/tag/{slug}"
    if settings.cache_enabled and not user:
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

    # Access control for hidden tags
    if not user:
        tag_service = TagService(db)
        hidden_ids = await tag_service.get_publicly_hidden_tag_ids()
        if tag.id in hidden_ids:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Tag not found",
            )

    # Get blog settings early for pagination
    settings_service = SettingsService(db)
    blog_settings = await settings_service.get_all_settings()

    per_page = blog_settings.get("posts_per_page", 12)

    # Find the latest featured post for this tag
    tag_service = TagService(db)
    featured_posts, _ = await tag_service.get_posts_by_tag(
        tag_id=tag.id,
        per_page=1,
        published_only=True,
        recursive=True,
        public_only=not user,
        featured_only=True,
    )
    featured_post = featured_posts[0] if featured_posts else None

    # Adjust per_page and offset
    # If featured, we want 1 featured + per_page plain posts on the first page
    actual_per_page = per_page
    actual_offset = (page - 1) * per_page

    # Get posts with this tag, excluding the main featured post if it exists
    posts, total = await tag_service.get_posts_by_tag(
        tag_id=tag.id,
        per_page=actual_per_page,
        offset=actual_offset,
        published_only=True,
        recursive=True,
        public_only=not user,
        exclude_id=featured_post.id if featured_post else None,
    )

    # Adjust total_pages calculation
    # 'total' here is the count of posts excluding the featured post
    if featured_post:
        total_pages = 1 + ceil(max(0, total - per_page) / per_page)
        if page == 1:
            posts = [featured_post] + posts
        # Restore total count for display in templates
        total = total + 1
    else:
        total_pages = ceil(total / per_page)


    # Check for AJAX request
    if request.headers.get("X-Requested-With") == "XMLHttpRequest":
        # Get publicly hidden tag IDs for filtering if not authenticated
        tag_filter_ids = None if user else (await tag_service.get_publicly_hidden_tag_ids())
        use_thumbs = blog_settings.get("use_thumbnails", True)
        posts_data = [serialize_post(p, tag_filter_ids, use_thumbs) for p in posts]
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
                "tag": {"name": tag.name, "slug": tag.slug, "post_count": tag.post_count},
                "is_logged_in": user is not None,
            }
        )

    context = get_common_context(request)
    db_context = await get_db_context(db, blog_settings, user)

    # Ensure current tag is in the tags list for navigation bar
    if tag not in db_context["tags"]:
        db_context["tags"].append(tag)
        # Sort again by name
        db_context["tags"].sort(key=lambda x: x.name)

    context.update(db_context)

    # Filter hidden tags from posts for non-authenticated users
    if not user:
        publicly_hidden_tag_ids = await tag_service.get_publicly_hidden_tag_ids()
        for post in posts:
            # Filter tags in-place
            post.tags = [t for t in post.tags if t.id not in publicly_hidden_tag_ids]

    context.update(
        {
            "tag": tag,
            "posts": posts,
            "page": page,
            "total_pages": total_pages,
            "total": total,
            "user": user,
        }
    )

    response = templates.TemplateResponse("public/tag.html", context)

    # Store in cache if enabled
    if settings.cache_enabled and request.headers.get("X-Requested-With") != "XMLHttpRequest" and not user:
        cache = await get_cache()
        query_params = {"page": page} if page > 1 else None
        content = bytes(response.body).decode("utf-8")
        await cache.set_by_url(
            cache_key,
            content,
            query_params,
            ttl=settings.cache_ttl_tag,
        )
        response.headers["X-Cache"] = "MISS"

    return response


@router.get("/tags", response_class=HTMLResponse)
async def tags_page(
    request: Request,
    tag_slug: str | None = None,
    page: int = 1,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
) -> Response:
    """Render the tags page (formerly gallery).

    Args:
        request: The current request
        tag_slug: Optional tag slug from path
        page: Page number for pagination
        db: Database session
        user: Current user (optional)

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
        .options(selectinload(Post.tags).selectinload(Tag.parents))
        .where(Post.status == PostStatus.PUBLISHED)
    )

    tag_service = TagService(db)
    if not user:
        # Filter out hidden-posts tags
        hidden_posts_tag_ids = await tag_service.get_hidden_posts_tag_ids()
        if hidden_posts_tag_ids:
             query = query.where(Post.id.notin_(
                select(post_tags.c.post_id).where(post_tags.c.tag_id.in_(hidden_posts_tag_ids))
            ))

    # Filter by tag if provided
    tag_obj = None
    if tag_slug:
        tag_service = TagService(db)
        tag_obj = await tag_service.get_tag_by_slug(tag_slug)

        if tag_obj:
            # Always include all children recursively to show a complete collection for any parent tag
            tag_ids = await tag_service.get_descendant_tag_ids(tag_obj.id)
            query = (
                query.join(post_tags, Post.id == post_tags.c.post_id)
                .where(post_tags.c.tag_id.in_(tag_ids))
                .distinct()
            )

    # Find the latest featured post in this context
    featured_query = query.where(Post.is_featured.is_(True)).limit(1)
    featured_result = await db.execute(featured_query)
    featured_post = featured_result.scalar_one_or_none()
    first_post_is_featured = featured_post is not None

    if featured_post:
        # Exclude the featured post from the main list
        query = query.where(Post.id != featured_post.id)

    query = query.order_by(Post.published_at.desc().nulls_last(), Post.created_at.desc())

    # Get total count of other posts
    count_query = select(func.count()).select_from(query.subquery())
    total_result = await db.execute(count_query)
    total_others = total_result.scalar() or 0

    # Adjust total_pages calculation
    if first_post_is_featured:
        total_pages = 1 + ceil(max(0, total_others - per_page) / per_page)
        total = total_others + 1
    else:
        total_pages = ceil(total_others / per_page)
        total = total_others

    # Get paginated posts
    posts_result = await db.execute(query.offset(offset).limit(per_page))
    posts = list(posts_result.scalars().all())

    if featured_post and page == 1:
        posts = [featured_post] + posts

    # Get all tags with posts for filter (hierarchical)
    tag_service = TagService(db)
    all_tags = await tag_service.get_hierarchical_tags(include_empty=False, public_only=(not user))

    # Check for AJAX request
    if request.headers.get("X-Requested-With") == "XMLHttpRequest":
        posts_data = []
        use_thumbs = blog_settings.get("use_thumbnails", True)

        for post in posts:
            pub_date = post.published_at or post.created_at

            # Calculate preview data
            thumb_path, is_video_thumb = determine_thumbnail(
                post.content,
                post.thumbnail_path,
                settings.storage_path,
                use_thumbs
            )

            has_image = thumb_path is not None
            excerpt = None
            preview_html = None

            if has_image:
                excerpt = post.excerpt or generate_excerpt(
                    post.content, post.formatter, 150
                )
            else:
                # Text-only preview
                content_html = format_content(post.content, post.formatter)
                preview_html = truncate_paragraphs(content_html)

            posts_data.append(
                {
                    "id": post.id,
                    "title": post.title,
                    "slug": post.slug,
                    "thumbnail_path": thumb_path,
                    "published_date": pub_date.strftime("%B %d, %Y"),
                    "published_iso": pub_date.isoformat(),
                    "view_count": post.view_count,
                    "tags": [{"name": t.name, "slug": t.slug, "post_count": t.post_count} for t in post.tags],
                    "excerpt": excerpt,
                    "preview_html": preview_html,
                    "has_image": has_image,
                    "is_video": is_video_thumb,
                    "is_featured": post.is_featured,
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
                "is_logged_in": user is not None,
            }
        )

    context = get_common_context(request)
    db_context = await get_db_context(db, blog_settings, user)
    context.update(db_context)

    context.update(
        {
            "posts": posts,
            "page": page,
            "total_pages": total_pages,
            "total": total,
            "tag_groups": all_tags,
            "tag": tag_obj,
            "current_tag": tag_slug,
            "user": user,
        }
    )

    return templates.TemplateResponse("public/tags.html", context)


@router.get("/map", response_class=HTMLResponse)
async def map_page(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
) -> Response:
    """Render the global map page.

    Args:
        request: The current request
        db: Database session
        user: Current user (optional)

    Returns:
        Rendered map HTML
    """
    # Get all tags with coordinates and posts
    tag_service = TagService(db)
    
    # Join with TagLocation to find tags that have at least one location
    from app.models.tag_location import TagLocation
    query = (
        select(Tag)
        .join(Tag.locations)
        .where(Tag.post_count > 0)
        .options(selectinload(Tag.locations))
    )
    
    if not user:
        hidden_ids = await tag_service.get_publicly_hidden_tag_ids()
        if hidden_ids:
            query = query.where(Tag.id.notin_(hidden_ids))
            
    result = await db.execute(query.order_by(Tag.name))
    map_tags = list(result.scalars().unique().all())

    # Check for AJAX request
    if request.headers.get("X-Requested-With") == "XMLHttpRequest":
        tags_data = []
        for t in map_tags:
            for loc in t.locations:
                tags_data.append({
                    "name": t.name,
                    "slug": t.slug,
                    "post_count": t.post_count,
                    "lat": loc.latitude,
                    "lng": loc.longitude,
                    "url": t.url
                })
        return JSONResponse({"tags": tags_data})

    context = get_common_context(request)
    db_context = await get_db_context(db, user=user)
    context.update(db_context)

    context.update(
        {
            "map_tags": map_tags,
            "user": user,
        }
    )

    return templates.TemplateResponse("public/map.html", context)


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
    user: User | None = Depends(get_current_user),
) -> Response:
    """Generate RSS feed.

    Args:
        request: The current request
        db: Database session
        user: Current user (optional)

    Returns:
        RSS feed XML
    """
    # Check cache if enabled
    if settings.cache_enabled and not user:
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

    # Get all published posts (limit to 20 for RSS feed)
    posts_query = (
        select(Post)
        .where(Post.status == PostStatus.PUBLISHED)
        .order_by(Post.published_at.desc().nulls_last(), Post.created_at.desc())
        .limit(20)
    )

    tag_service = TagService(db)
    if not user:
        # Filter out hidden-posts tags
        hidden_posts_tag_ids = await tag_service.get_hidden_posts_tag_ids()
        if hidden_posts_tag_ids:
             posts_query = posts_query.where(Post.id.notin_(
                select(post_tags.c.post_id).where(post_tags.c.tag_id.in_(hidden_posts_tag_ids))
            ))

    posts_result = await db.execute(posts_query)
    posts = list(posts_result.scalars().all())

    # Format posts for RSS
    settings_service = SettingsService(db)
    blog_settings = await settings_service.get_all_settings()
    posts_data: list[dict[str, Any]] = []
    use_thumbs = blog_settings.get("use_thumbnails", True)

    for post in posts:
        pub_date = post.published_at or post.created_at

        # Resolve thumbnail
        thumb_path, _ = determine_thumbnail(
            post.content,
            post.thumbnail_path,
            settings.storage_path,
            use_thumbs
        )

        posts_data.append(
            {
                "title": post.title,
                "slug": post.slug,
                "pub_date_rfc822": pub_date.strftime("%a, %d %b %Y %H:%M:%S GMT"),
                "content_html": format_content(post.content, post.formatter),
                "meta_description": None,
                "excerpt": post.excerpt,
                "thumbnail_path": thumb_path,
                "tags": [],  # Empty for now as tags are filtered for public
            }
        )

    build_date = datetime.now(UTC).strftime("%a, %d %b %Y %H:%M:%S GMT")
    base_url = get_base_url(request)

    context = {
        "request": request,
        "blog_title": blog_settings.get("blog_title", settings.app_name),
        "blog_subtitle": blog_settings.get("blog_subtitle", getattr(settings, "blog_subtitle", "")),
        "author_name": blog_settings.get("author_name", getattr(settings, "author_name", "Light")),
        "author_email": blog_settings.get("author_email", getattr(settings, "author_email", "")),
        "language": blog_settings.get("default_language", getattr(settings, "default_language", "en")),
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

    posts_query = (
        select(Post)
        .where(Post.status == PostStatus.PUBLISHED)
        .order_by(Post.published_at.desc().nulls_last(), Post.created_at.desc())
    )

    tag_service = TagService(db)
    # Filter out hidden-posts tags
    hidden_posts_tag_ids = await tag_service.get_hidden_posts_tag_ids()
    if hidden_posts_tag_ids:
         posts_query = posts_query.where(Post.id.notin_(
            select(post_tags.c.post_id).where(post_tags.c.tag_id.in_(hidden_posts_tag_ids))
        ))

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
    hidden_ids = await tag_service.get_publicly_hidden_tag_ids()
    tags_query = select(Tag).where(Tag.post_count > 0).order_by(Tag.name)
    if hidden_ids:
        tags_query = tags_query.where(Tag.id.notin_(hidden_ids))

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
    content = f"""User-agent: *
Allow: /
Disallow: /light/
Disallow: /api/
Sitemap: {request.base_url}sitemap.xml
"""
    return PlainTextResponse(
        content=content,
        headers={"Cache-Control": "public, max-age=86400"},
    )
