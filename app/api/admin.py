"""Light interface routes.

Renders HTML pages for the light dashboard and management interface.
"""

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse
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


def get_base_context(request: Request, user: User | None = None) -> dict[str, Any]:
    """Get base context for all light templates.

    Args:
        request: FastAPI request
        user: Optional current user

    Returns:
        Base context dictionary
    """
    return {
        "request": request,
        "user": user,
        "settings": settings,
        "app_name": settings.app_name,
    }


async def require_auth(
    request: Request,
    user: User | None = Depends(get_current_user),
) -> User:
    """Require authentication for light routes.

    Args:
        request: FastAPI request
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
    user: User | None = Depends(get_current_user),
) -> HTMLResponse:
    """Render login page.

    Args:
        request: FastAPI request
        user: Current user (if already logged in)

    Returns:
        Login page HTML or redirect to dashboard
    """
    if user:
        return RedirectResponse(url="/light/", status_code=status.HTTP_303_SEE_OTHER)

    context = get_base_context(request)
    context["error"] = request.query_params.get("error")
    return templates.TemplateResponse("light/login.html", context)


@router.get("/", response_class=HTMLResponse)
async def dashboard(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
) -> HTMLResponse:
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

    context = get_base_context(request, user)
    context.update(
        {
            "total_posts": total_posts or 0,
            "published_posts": published_posts or 0,
            "draft_posts": draft_posts or 0,
            "total_views": total_views,
            "total_tags": total_tags or 0,
            "total_media": total_media or 0,
            "storage_used_mb": round(storage_used_mb, 2),
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
) -> HTMLResponse:
    """Render posts list page.

    Args:
        request: FastAPI request
        db: Database session
        user: Current user
        page: Page number
        status_filter: Optional status filter

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
        try:
            status_enum = PostStatus(status_filter)
        except ValueError:
            pass

    post_service = PostService(db)
    posts, total = await post_service.list_posts(
        page=page,
        per_page=per_page,
        status=status_enum,
        include_drafts=True,
    )

    total_pages = (total + per_page - 1) // per_page

    context = get_base_context(request, user)
    context.update(
        {
            "posts": posts,
            "page": page,
            "total_pages": total_pages,
            "total": total,
            "status_filter": status_filter,
            "statuses": [s.value for s in PostStatus],
        }
    )
    return templates.TemplateResponse("light/posts_list.html", context)


@router.get("/posts/new", response_class=HTMLResponse)
async def new_post(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
) -> HTMLResponse:
    """Render new post editor.

    Args:
        request: FastAPI request
        db: Database session
        user: Current user

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

    context = get_base_context(request, user)
    context.update(
        {
            "post": None,
            "tags": tags,
            "all_tags": [t.name for t in tags],
            "statuses": [s.value for s in PostStatus],
        }
    )
    return templates.TemplateResponse("light/post_edit.html", context)


@router.get("/posts/{post_id}", response_class=HTMLResponse)
async def edit_post(
    request: Request,
    post_id: int,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
) -> HTMLResponse:
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

    # Get all tags for autocomplete
    tag_service = TagService(db)
    tags = await tag_service.list_tags()

    # Get post's current tags
    post_tags = [t.name for t in post.tags]

    context = get_base_context(request, user)
    context.update(
        {
            "post": post,
            "post_tags": post_tags,
            "tags": tags,
            "all_tags": [t.name for t in tags],
            "statuses": [s.value for s in PostStatus],
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
    sort_by: str = "name",
    sort_order: str = "asc",
) -> HTMLResponse:
    """Render tags management page.

    Args:
        request: FastAPI request
        db: Database session
        user: Current user
        page: Page number
        search: Optional search term
        sort_by: Column to sort by
        sort_order: Sort order (asc/desc)

    Returns:
        Tags page HTML
    """
    if not user:
        return RedirectResponse(
            url="/light/login", status_code=status.HTTP_303_SEE_OTHER
        )

    tag_service = TagService(db)
    tags = await tag_service.list_tags(
        search=search, sort_by=sort_by, sort_order=sort_order
    )
    total = len(tags)
    total_pages = 1

    context = get_base_context(request, user)
    context.update(
        {
            "tags": tags,
            "page": page,
            "total_pages": total_pages,
            "total": total,
            "search": search,
            "sort_by": sort_by,
            "sort_order": sort_order,
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
) -> HTMLResponse:
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
    file_types = [row[0] for row in result.all()]

    context = get_base_context(request, user)
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
) -> HTMLResponse:
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

    context = get_base_context(request, user)
    context.update(
        {
            "blog_settings": blog_settings,
        }
    )
    return templates.TemplateResponse("light/settings.html", context)


@router.get("/security", response_class=HTMLResponse)
async def security_page(
    request: Request,
    user: User | None = Depends(get_current_user),
) -> HTMLResponse:
    """Render security settings page.

    Args:
        request: FastAPI request
        user: Current user

    Returns:
        Security page HTML
    """
    if not user:
        return RedirectResponse(
            url="/light/login", status_code=status.HTTP_303_SEE_OTHER
        )

    context = get_base_context(request, user)
    return templates.TemplateResponse("light/security.html", context)


@router.get("/system", response_class=HTMLResponse)
async def system_page(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
) -> HTMLResponse:
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

    context = get_base_context(request, user)
    context.update(
        {
            "stats": stats,
            "logs": logs,
        }
    )
    return templates.TemplateResponse("light/system.html", context)


@router.get("/logout")
async def logout(request: Request) -> RedirectResponse:
    """Logout and redirect to login page.

    Args:
        request: FastAPI request

    Returns:
        Redirect to login page
    """
    response = RedirectResponse(
        url="/light/login", status_code=status.HTTP_303_SEE_OTHER
    )
    response.delete_cookie("session_token")
    return response
