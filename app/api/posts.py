"""Post API endpoints.

Handles CRUD operations for blog posts.
"""

import math
import re
from pathlib import PurePosixPath
from typing import Any

_VIDEO_EXT = frozenset({'.mp4', '.webm', '.mov', '.m4v', '.ogv'})
_AUDIO_EXT = frozenset({'.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.oga'})


def _media_type(url: str) -> str:
    ext = PurePosixPath(url.lower()).suffix
    if ext in _VIDEO_EXT:
        return 'video'
    if ext in _AUDIO_EXT:
        return 'audio'
    return 'image'


def _extract_media(content: str) -> list[dict[str, str]]:
    """Return ordered list of unique media items found in post content."""
    seen: set[str] = set()
    items: list[dict[str, str]] = []

    def add(url: str, alt: str = '') -> None:
        if url and url not in seen:
            seen.add(url)
            item: dict[str, str] = {'url': url, 'type': _media_type(url)}
            if alt:
                item['alt'] = alt
            items.append(item)

    # /YYYY/MM/filename.ext  (simplified upload paths)
    for m in re.finditer(
        r'/\d{4}/\d{2}/[^\s"\'<>)\]]+\.(?:jpe?g|png|gif|webp|svg|mp4|mov|webm|mp3|wav|ogg|m4a)',
        content, re.IGNORECASE,
    ):
        add(m.group(0))

    # Markdown images: ![alt](url)
    for m in re.finditer(r'!\[([^\]]*)\]\(([^)\s]+)\)', content):
        add(m.group(2), m.group(1))

    # HTML <img src="...">
    for m in re.finditer(r'<img\b[^>]+\bsrc="([^"]+)"(?:[^>]+\balt="([^"]*)")?', content, re.IGNORECASE):
        add(m.group(1), m.group(2) or '')

    # HTML <video|audio|source src="...">
    for m in re.finditer(r'<(?:video|audio|source)\b[^>]+\bsrc="([^"]+)"', content, re.IGNORECASE):
        add(m.group(1))

    return items

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.dependencies import get_current_user, require_auth
from app.models.post import Post as PostModel
from app.models.post import PostStatus
from app.models.user import User
from app.schemas.post import (
    PostCreate,
    PostListItem,
    PostListResponse,
    PostResponse,
    PostUpdate,
    PreviewLinkResponse,
)
from app.schemas.post import PostStatus as PostStatusSchema
from app.services.media_service import MediaService
from app.services.post_service import PostService
from app.services.tag_service import TagService
from app.utils.validators import FileValidationError, validate_upload_file

settings = get_settings()

router = APIRouter(prefix="/api/posts", tags=["Posts"])


def post_to_response(
    post: PostModel, service: PostService, include_content: bool = True
) -> dict[str, Any]:
    """Convert Post model to response dict.

    Args:
        post: Post model instance
        service: Post service for rendering
        include_content: Whether to include full content

    Returns:
        Dict suitable for PostResponse or PostListItem
    """
    data = {
        "id": post.id,
        "title": post.title,
        "slug": post.slug,
        "excerpt": post.excerpt,
        "status": post.status,
        "is_featured": post.is_featured,
        "view_count": post.view_count,
        "published_at": post.published_at,
        "created_at": post.created_at,
        "updated_at": post.updated_at,
        "author": {
            "id": post.author.id,
            "username": post.author.username,
            "display_name": post.author.display_name,
            "avatar_path": post.author.avatar_path,
        },
        "thumbnail_path": post.thumbnail_path,
        "tags": [tag.name for tag in post.tags],
        "is_hidden": post.is_hidden(),
        "is_hidden_by_tag": post.is_affected_by_hidden_tag(),
    }

    if include_content:
        data["content"] = post.content
        data["content_html"] = service.render_content(post)
        data["formatter"] = post.formatter
        data["meta_description"] = post.meta_description
        data["media"] = _extract_media(post.content or '')

    return data


@router.get(
    "",
    response_model=PostListResponse,
    summary="List posts",
)
async def list_posts(
    page: int = Query(default=1, ge=1, description="Page number"),
    per_page: int = Query(default=10, ge=1, le=100, description="Items per page"),
    status: PostStatusSchema | None = Query(
        default=None, description="Filter by status"
    ),
    featured: bool = Query(default=False, description="Only featured posts"),
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
) -> PostListResponse:
    """List posts with pagination and filters.

    Public endpoint shows only published posts.
    Authenticated users can see all posts including drafts.
    """
    service = PostService(db)

    # Convert schema status to model status
    model_status = PostStatus(status.value) if status else None

    posts, total = await service.list_posts(
        page=page,
        per_page=per_page,
        status=model_status,
        featured_only=featured,
        include_drafts=current_user is not None,
    )

    pages = math.ceil(total / per_page) if total > 0 else 1

    return PostListResponse(
        posts=[
            PostListItem(**post_to_response(p, service, include_content=False))
            for p in posts
        ],
        total=total,
        page=page,
        per_page=per_page,
        pages=pages,
    )


@router.post(
    "",
    response_model=PostResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new post",
)
async def create_post(
    post_data: PostCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_auth),
) -> PostResponse:
    """Create a new blog post.

    Requires authentication.
    """
    service = PostService(db)
    tag_service = TagService(db)
    post = await service.create_post_with_tags(post_data, current_user.id, tag_service)
    await db.commit()

    return PostResponse(**post_to_response(post, service))


@router.post(
    "/audio",
    response_model=PostResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Upload audio file as post",
)
async def create_audio_post(
    file: UploadFile = File(..., description="Audio file to upload"),
    title: str | None = Form(default=None, description="Optional title"),
    tags: str | None = Form(default=None, description="Comma-separated tags"),
    post_status: PostStatusSchema = Form(default=PostStatusSchema.PUBLISHED),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_auth),
) -> PostResponse:
    """Upload an audio file and create a blog post for it.

    Supports MP3, WAV, OGG, M4A.
    If title is not provided, the filename (without extension) will be used.
    Requires authentication.
    """
    # 1. Validate and upload file
    try:
        content, filename, mime_type, file_size = await validate_upload_file(file)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    # Ensure it's audio
    if not mime_type.startswith("audio/"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Uploaded file is not an audio file (type: {mime_type})",
        )

    media_service = MediaService(db)
    post_service = PostService(db)
    tag_service = TagService(db)

    try:
        # Create media record
        media = await media_service.upload_file(
            content=content,
            filename=filename,
            mime_type=mime_type,
        )

        # 2. Create post
        # Generate title from filename if not provided
        post_title = title or re.sub(r"\.[^.]+$", "", filename).replace("_", " ").title()

        # Create audio player line
        # This uses the simplified media path format: /YYYY/MM/filename
        # which is handled by preprocess_media_links
        # Media.url returns /YYYY/MM/filename
        audio_url = media_service.get_media_url(media)
        post_content = f"{audio_url}\n"

        # Prepare tags list
        tags_list = []
        if tags:
            tags_list = [t.strip() for t in tags.split(",") if t.strip()]

        post_data = PostCreate(
            title=post_title,
            content=post_content,
            status=post_status,
            tags=tags_list,
        )

        post = await post_service.create_post_with_tags(post_data, current_user.id, tag_service)

        # Link media to post
        await media_service.update_media(media.id, post_id=post.id)

        await db.commit()
        await db.refresh(post)

        return PostResponse(**post_to_response(post, post_service))

    except FileValidationError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"message": e.message, "field": e.field},
        )


@router.get(
    "/{post_id}",
    response_model=PostResponse,
    summary="Get post by ID",
)
async def get_post(
    post_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
) -> PostResponse:
    """Get a post by ID.

    Public users can only see published posts.
    Authenticated users can see all posts.
    """
    service = PostService(db)
    post = await service.get_post_by_id(
        post_id, include_hidden=current_user is not None
    )

    if not post:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Post not found",
        )

    # Check if user can view draft
    if post.status == PostStatus.DRAFT and (
        not current_user or post.author_id != current_user.id
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Post not found",
        )

    return PostResponse(**post_to_response(post, service))


@router.get(
    "/slug/{slug}",
    response_model=PostResponse,
    summary="Get post by slug",
)
async def get_post_by_slug(
    slug: str,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
) -> PostResponse:
    """Get a post by slug.

    Public users can only see published posts.
    """
    service = PostService(db)
    post = await service.get_post_by_slug(slug, include_drafts=current_user is not None)

    if not post:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Post not found",
        )

    # Increment view count for published posts
    if post.status == PostStatus.PUBLISHED:
        await service.increment_view_count(post.id)

    return PostResponse(**post_to_response(post, service))


@router.put(
    "/{post_id}",
    response_model=PostResponse,
    summary="Update a post",
)
async def update_post(
    post_id: int,
    post_data: PostUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_auth),
) -> PostResponse:
    """Update an existing post.

    Requires authentication. Users can only update their own posts.
    """
    service = PostService(db)
    tag_service = TagService(db)
    post = await service.update_post_with_tags(
        post_id, post_data, tag_service, current_user.id
    )

    if not post:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Post not found or access denied",
        )

    await db.commit()
    return PostResponse(**post_to_response(post, service))


@router.delete(
    "/{post_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a post",
)
async def delete_post(
    post_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_auth),
) -> None:
    """Delete a post.

    Requires authentication. Users can only delete their own posts.
    """
    service = PostService(db)
    success = await service.delete_post(post_id, current_user.id)

    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Post not found or access denied",
        )


@router.post(
    "/{post_id}/publish",
    response_model=PostResponse,
    summary="Publish a draft post",
)
async def publish_post(
    post_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_auth),
) -> PostResponse:
    """Publish a draft post.

    Sets status to published and records publication time.
    """
    service = PostService(db)

    # Verify ownership
    post = await service.get_post_by_id(post_id, include_hidden=True)
    if not post or post.author_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Post not found or access denied",
        )

    post = await service.publish_post(post_id)
    if not post:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Post not found",
        )

    return PostResponse(**post_to_response(post, service))


@router.post(
    "/{post_id}/withdraw",
    response_model=PostResponse,
    summary="Withdraw a published post",
)
async def withdraw_post(
    post_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_auth),
) -> PostResponse:
    """Withdraw a published post to draft status."""
    service = PostService(db)

    # Verify ownership
    post = await service.get_post_by_id(post_id, include_hidden=True)
    if not post or post.author_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Post not found or access denied",
        )

    post = await service.withdraw_post(post_id)
    if not post:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Post not found",
        )

    return PostResponse(**post_to_response(post, service))


@router.post(
    "/{post_id}/preview",
    response_model=PreviewLinkResponse,
    summary="Generate preview link",
)
async def generate_preview_link(
    post_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_auth),
) -> PreviewLinkResponse:
    """Generate a preview link for a draft post.

    Preview links expire after 7 days.
    """
    service = PostService(db)

    # Verify ownership
    post = await service.get_post_by_id(post_id, include_hidden=True)
    if not post or post.author_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Post not found or access denied",
        )

    result = await service.generate_preview_link(post_id)
    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Post not found",
        )

    token, expires_at = result

    # Build preview URL
    base_url = str(request.base_url).rstrip("/")
    preview_url = f"{base_url}/preview/{token}"

    return PreviewLinkResponse(
        preview_url=preview_url,
        expires_at=expires_at,
        token=token,
    )


@router.get(
    "/{post_id}/preview",
    response_model=PostResponse,
    summary="Get post via preview token",
    include_in_schema=False,
)
async def get_preview(
    post_id: int,
    token: str = Query(..., description="Preview token"),
    db: AsyncSession = Depends(get_db),
) -> PostResponse:
    """Access a draft post via preview token.

    This is an alternative way to access preview - the main way is /preview/{token}.
    """
    service = PostService(db)
    post = await service.get_post_by_id(post_id, include_hidden=True)

    if not post or post.preview_token != token or not post.preview_is_valid:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Invalid or expired preview link",
        )

    return PostResponse(**post_to_response(post, service))
