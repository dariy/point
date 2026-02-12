"""Light interface routes.

Renders HTML pages for the light dashboard and management interface.
"""

import contextlib
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.dependencies import get_current_user
from app.models.media import Media
from app.models.post import Post, PostStatus
from app.models.session import Session
from app.models.tag import Tag
from app.models.user import User
from app.services.media_service import MediaService
from app.services.post_service import PostService
from app.services.settings_service import SettingsService
from app.services.system_service import SystemService
from app.services.tag_service import TagService

router = APIRouter(prefix="/light", tags=["Light"])

# Set up templates
templates_dir = Path(__file__).parent.parent / "templates"
templates = Jinja2Templates(directory=str(templates_dir))

settings = get_settings()


async def get_base_context(db: AsyncSession, request: Request, user: User | None = None) -> dict[str, Any]:
    """Get base context for all light templates.

    Args:
        db: Database session
        request: FastAPI request
        user: Optional current user

    Returns:
        Base context dictionary
    """
    settings_service = SettingsService(db)
    blog_title = await settings_service.get_setting("blog_title")
    return {
        "request": request,
        "user": user,
        "settings": settings,
        "app_name": blog_title or settings.app_name,
        "app_version": settings.app_version,
        "public_url": "/",
    }


async def require_auth(
    user: User | None = Depends(get_current_user),
) -> User:
    """Require authentication for light routes.

    Args:
        user: Current user or None

    Returns:
        Authenticated user

    Raises:
        RedirectResponse: If not authenticated, redirects to login
    """
    if not user:
        raise HTTPException(
            status_code=status.HTTP_303_SEE_OTHER,
            headers={"Location": "/light/login"},
        )
    return user


@router.get("/login", response_class=HTMLResponse)
async def login_page(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
) -> Response:
    """Render login page.

    Args:
        request: FastAPI request
        db: Database session
        user: Current user (if already logged in)

    Returns:
        Login page HTML or redirect to dashboard
    """
    if user:
        return RedirectResponse(url="/light/", status_code=status.HTTP_303_SEE_OTHER)

    context = await get_base_context(db, request)
    context["error"] = request.query_params.get("error")
    return templates.TemplateResponse("light/login.html", context)


@router.get("/", response_class=HTMLResponse)
async def dashboard(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
) -> Response:
    """Render light dashboard.

    Args:
        request: FastAPI request
        db: Database session
        user: Current user

    Returns:
        Dashboard page HTML
    """
    if not user:
        return RedirectResponse(
            url="/light/login", status_code=status.HTTP_303_SEE_OTHER
        )

    # Get statistics
    total_posts = await db.scalar(select(func.count()).select_from(Post))
    published_posts = await db.scalar(
        select(func.count())
        .select_from(Post)
        .where(Post.status == PostStatus.PUBLISHED)
    )
    draft_posts = await db.scalar(
        select(func.count()).select_from(Post).where(Post.status == PostStatus.DRAFT)
    )
    total_views = (
        await db.scalar(select(func.sum(Post.view_count)).select_from(Post)) or 0
    )
    total_tags = await db.scalar(select(func.count()).select_from(Tag))
    total_media = await db.scalar(select(func.count()).select_from(Media))

    # Calculate storage usage
    storage_path = Path(settings.storage_path) / "media"
    storage_used = sum(f.stat().st_size for f in storage_path.rglob("*") if f.is_file())
    storage_used_mb = storage_used / (1024 * 1024)

    # Get recent posts
    post_service = PostService(db)
    recent_posts, _ = await post_service.list_posts(
        page=1, per_page=5, include_drafts=True
    )

    # Get active sessions count
    active_sessions = await db.scalar(select(func.count()).select_from(Session))

    context = await get_base_context(db, request, user)
    context.update(
        {
            "total_posts": total_posts or 0,
            "published_posts": published_posts or 0,
            "draft_posts": draft_posts or 0,
            "total_views": total_views,
            "total_tags": total_tags or 0,
            "total_media": total_media or 0,
            "storage_used_mb": round(float(storage_used_mb), 2),
            "storage_quota_mb": settings.storage_quota_mb,
            "recent_posts": recent_posts,
            "active_sessions": active_sessions or 0,
        }
    )
    return templates.TemplateResponse("light/dashboard.html", context)


@router.get("/posts", response_class=HTMLResponse)
async def posts_list(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
    page: int = 1,
    status_filter: str | None = None,
    search: str | None = None,
    tag_id: int | None = None,
) -> Response:
    """Render posts list page.

    Args:
        request: FastAPI request
        db: Database session
        user: Current user
        page: Page number
        status_filter: Optional status filter
        search: Optional search query
        tag_id: Optional tag ID filter

    Returns:
        Posts list page HTML
    """
    if not user:
        return RedirectResponse(
            url="/light/login", status_code=status.HTTP_303_SEE_OTHER
        )

    per_page = 20
    status_enum = None
    if status_filter:
        with contextlib.suppress(ValueError):
            status_enum = PostStatus(status_filter)

    post_service = PostService(db)
    tag_service = TagService(db)

    posts, total = await post_service.list_posts(
        page=page,
        per_page=per_page,
        status=status_enum,
        include_drafts=True,
        search=search,
        tag_id=tag_id,
    )

    all_tags = await tag_service.list_tags()
    total_pages = (total + per_page - 1) // per_page

    context = await get_base_context(db, request, user)
    context.update(
        {
            "posts": posts,
            "page": page,
            "total_pages": total_pages,
            "total": total,
            "status_filter": status_filter,
            "search_query": search,
            "tag_id": tag_id,
            "all_tags": all_tags,
            "statuses": [s.value for s in PostStatus],
        }
    )
    return templates.TemplateResponse("light/posts_list.html", context)


@router.get("/posts/new", response_class=HTMLResponse)
async def new_post(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
    media_id: int | None = None,
    media_path: str | None = None,
) -> Response:
    """Render new post editor.

    Args:
        request: FastAPI request
        db: Database session
        user: Current user
        media_id: Optional pre-uploaded media ID (from drag-drop)
        media_path: Optional pre-uploaded media path (from drag-drop)

    Returns:
        Post editor page HTML
    """
    if not user:
        return RedirectResponse(
            url="/light/login", status_code=status.HTTP_303_SEE_OTHER
        )

    # Get all tags for autocomplete
    tag_service = TagService(db)
    tags = await tag_service.list_tags()

    # If media was pre-uploaded via drag-drop, prepare initial content
    initial_content = ""
    initial_thumbnail = None
    if media_id:
        media_service = MediaService(db)
        media = await media_service.get_media_by_id(media_id)
        if media:
            # Create markdown image reference
            initial_content = f"![]({media_service.get_media_url(media)})"
            initial_thumbnail = media_service.get_thumbnail_url(media) or media_service.get_media_url(media)

    # Fallback to media_path if provided (used in tests and legacy links)
    if not initial_content and media_path:
        # Note: media_path usually includes 'originals/' or 'thumbnails/'
        # but the tests seem to expect /media/ prefix to be added
        initial_content = f"![](/media/{media_path})"
        initial_thumbnail = f"/media/{media_path}"


    context = await get_base_context(db, request, user)
    context.update(
        {
            "post": None,
            "tags": tags,
            "all_tags": [t.name for t in tags],

            "statuses": [s.value for s in PostStatus],
            "initial_content": initial_content,
            "initial_thumbnail": initial_thumbnail,
            "dropped_media_id": media_id,
        }
    )
    return templates.TemplateResponse("light/post_edit.html", context)


@router.get("/posts/{post_id}", response_class=HTMLResponse)
async def edit_post(
    request: Request,
    post_id: int,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
) -> Response:
    """Render post editor for existing post.

    Args:
        request: FastAPI request
        post_id: Post ID to edit
        db: Database session
        user: Current user

    Returns:
        Post editor page HTML
    """
    if not user:
        return RedirectResponse(
            url="/light/login", status_code=status.HTTP_303_SEE_OTHER
        )

    post_service = PostService(db)
    post = await post_service.get_post_by_id(post_id, include_hidden=True)

    if not post:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Post not found"
        )

    # Get all tags for autocomplete and hierarchy
    tag_service = TagService(db)
    tags = await tag_service.list_tags()


    # Get post's current tags
    post_tags = [t.name for t in post.tags]

    context = await get_base_context(db, request, user)
    context.update(
        {
            "post": post,
            "post_tags": post_tags,
            "tags": tags,
            "all_tags": [t.name for t in tags],

            "statuses": [s.value for s in PostStatus],
            "public_url": f"/posts/{post.slug}",
        }
    )
    return templates.TemplateResponse("light/post_edit.html", context)


@router.get("/tags", response_class=HTMLResponse)
async def tags_page(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
    page: int = 1,
    search: str | None = None,
    parent_id: str | None = None,
    sort_by: str = "name",
    sort_order: str = "asc",
) -> Response:
    """Render tags management page.

    Args:
        request: FastAPI request
        db: Database session
        user: Current user
        page: Page number
        search: Optional search term
        parent_id: Optional parent tag ID filter (string to handle empty form values)
        sort_by: Column to sort by
        sort_order: Sort order (asc/desc)

    Returns:
        Tags page HTML
    """
    if not user:
        return RedirectResponse(
            url="/light/login", status_code=status.HTTP_303_SEE_OTHER
        )

    # Handle empty parent_id from form submission
    pid = None
    if parent_id and parent_id.isdigit():
        pid = int(parent_id)

    tag_service = TagService(db)
    tags = await tag_service.list_tags(
        search=search, parent_id=pid, sort_by=sort_by, sort_order=sort_order
    )
    all_tags = await tag_service.list_tags()
    hierarchy = await tag_service.get_hierarchical_tags(search=search)
    # For filter dropdown, we want tags that ARЕ parents
    parent_tags = [t for t in all_tags if len(t.children) > 0]
    total = len(tags)
    total_pages = 1


    context = await get_base_context(db, request, user)
    context.update(
        {
            "tags": tags,
            "hierarchy": hierarchy,
            "page": page,
            "total_pages": total_pages,
            "total": total,
            "search": search,
            "parent_id": pid,
            "parent_tags": parent_tags,
            "all_tags": all_tags,
            "sort_by": sort_by,
            "sort_order": sort_order,

            "public_url": "/tags",
        }
    )
    return templates.TemplateResponse("light/tags.html", context)


@router.get("/media", response_class=HTMLResponse)
async def media_page(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
    page: int = 1,
    file_type: str | None = None,
) -> Response:
    """Render media library page.

    Args:
        request: FastAPI request
        db: Database session
        user: Current user
        page: Page number
        file_type: Optional file type filter

    Returns:
        Media library page HTML
    """
    if not user:
        return RedirectResponse(
            url="/light/login", status_code=status.HTTP_303_SEE_OTHER
        )

    per_page = 24
    media_service = MediaService(db)
    media_items, total = await media_service.list_media(
        page=page,
        per_page=per_page,
        file_type=file_type,
    )

    total_pages = (total + per_page - 1) // per_page

    # Get unique file types for filter
    result = await db.execute(select(Media.file_type).distinct())
    file_types = [row[0].value for row in result.all()]

    context = await get_base_context(db, request, user)
    context.update(
        {
            "media_items": media_items,
            "page": page,
            "total_pages": total_pages,
            "total": total,
            "file_type": file_type,
            "file_types": file_types,
        }
    )
    return templates.TemplateResponse("light/media.html", context)


@router.get("/settings", response_class=HTMLResponse)
async def settings_page(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
) -> Response:
    """Render blog settings page.

    Args:
        request: FastAPI request
        db: Database session
        user: Current user

    Returns:
        Settings page HTML
    """
    if not user:
        return RedirectResponse(
            url="/light/login", status_code=status.HTTP_303_SEE_OTHER
        )

    settings_service = SettingsService(db)
    blog_settings = await settings_service.get_all_settings()

    # Get all posts for the "About post" dropdown
    post_service = PostService(db)
    all_posts, _ = await post_service.list_posts(
        page=1, per_page=1000, include_drafts=True
    )

    context = await get_base_context(db, request, user)
    context.update(
        {
            "blog_settings": blog_settings,
            "all_posts": all_posts,
        }
    )
    return templates.TemplateResponse("light/settings.html", context)


@router.get("/security", response_class=HTMLResponse)
async def security_page(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
) -> Response:
    """Render security settings page.

    Args:
        request: FastAPI request
        db: Database session
        user: Current user

    Returns:
        Security page HTML
    """
    if not user:
        return RedirectResponse(
            url="/light/login", status_code=status.HTTP_303_SEE_OTHER
        )

    context = await get_base_context(db, request, user)
    return templates.TemplateResponse("light/security.html", context)


@router.get("/system", response_class=HTMLResponse)
async def system_page(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
) -> Response:
    """Render system tools page.

    Args:
        request: FastAPI request
        db: Database session
        user: Current user

    Returns:
        System tools page HTML
    """
    if not user:
        return RedirectResponse(
            url="/light/login", status_code=status.HTTP_303_SEE_OTHER
        )

    system_service = SystemService(db)
    stats = await system_service.get_system_stats()
    logs = system_service.get_logs(log_type="app", lines=50)

    context = await get_base_context(db, request, user)
    context.update(
        {
            "stats": stats,
            "logs": logs,
        }
    )
    return templates.TemplateResponse("light/system.html", context)


@router.get("/logout")
async def logout() -> RedirectResponse:
    """Logout and redirect to login page.

    Returns:
        Redirect to login page
    """
    response = RedirectResponse(
        url="/light/login", status_code=status.HTTP_303_SEE_OTHER
    )
    response.delete_cookie("session_token")
    return response
