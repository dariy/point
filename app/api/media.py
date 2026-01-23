"""Media API endpoints.

Handles file upload, listing, and management operations.
"""

import math
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import require_auth
from app.models.media import Media as MediaModel
from app.models.user import User
from app.schemas.media import (
    BulkDeleteResponse,
    MediaDeleteResponse,
    MediaListResponse,
    MediaResponse,
    MediaUpdate,
    MediaUploadResponse,
    MultipleMediaUploadResponse,
    OrphanedMediaResponse,
    StorageStatsResponse,
)
from app.services.media_service import MediaService
from app.utils.validators import FileValidationError, validate_upload_file

router = APIRouter(prefix="/api/media", tags=["Media"])


def media_to_response(media: MediaModel, service: MediaService) -> dict[str, Any]:
    """Convert Media model to response dict.

    Args:
        media: Media model instance
        service: Media service for URL generation

    Returns:
        Dict suitable for MediaResponse
    """
    return {
        "id": media.id,
        "filename": media.filename,
        "original_path": media.original_path,
        "thumbnail_path": media.thumbnail_path,
        "file_type": media.file_type,
        "mime_type": media.mime_type,
        "file_size": media.file_size,
        "width": media.width,
        "height": media.height,
        "post_id": media.post_id,
        "uploaded_at": media.uploaded_at,
        "checksum": media.checksum,
        "alt_text": media.alt_text,
        "caption": media.caption,
        "url": service.get_media_url(media),
        "thumbnail_url": service.get_thumbnail_url(media),
    }


def media_to_list_item(media: MediaModel, service: MediaService) -> dict[str, Any]:
    """Convert Media model to list item dict.

    Args:
        media: Media model instance
        service: Media service for URL generation

    Returns:
        Dict suitable for MediaListItem
    """
    return {
        "id": media.id,
        "filename": media.filename,
        "file_type": media.file_type,
        "mime_type": media.mime_type,
        "file_size": media.file_size,
        "width": media.width,
        "height": media.height,
        "uploaded_at": media.uploaded_at,
        "url": service.get_media_url(media),
        "thumbnail_url": service.get_thumbnail_url(media),
        "post_id": media.post_id,
        "is_orphaned": media.is_orphaned,
    }


@router.get(
    "",
    response_model=MediaListResponse,
    summary="List media files",
)
async def list_media(
    page: int = Query(default=1, ge=1, description="Page number"),
    per_page: int = Query(default=20, ge=1, le=100, description="Items per page"),
    file_type: str | None = Query(default=None, description="Filter by type (image, video, audio)"),
    orphaned_only: bool = Query(default=False, description="Only show orphaned files"),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
):
    """List all media files with pagination.

    Requires authentication.
    """
    service = MediaService(db)
    media_list, total = await service.list_media(
        page=page,
        per_page=per_page,
        file_type=file_type,
        orphaned_only=orphaned_only,
    )

    pages = math.ceil(total / per_page) if total > 0 else 1

    return {
        "media": [media_to_list_item(m, service) for m in media_list],
        "total": total,
        "page": page,
        "per_page": per_page,
        "pages": pages,
    }


@router.post(
    "/upload",
    response_model=MediaUploadResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Upload a single file",
)
async def upload_file(
    file: UploadFile = File(..., description="File to upload"),
    alt_text: str | None = Form(default=None, description="Alt text for images"),
    caption: str | None = Form(default=None, description="Caption for the file"),
    post_id: int | None = Form(default=None, description="Post ID to link to"),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
):
    """Upload a single media file.

    Supports images (JPG, PNG, GIF, WebP, SVG), videos (MP4, MOV, WebM),
    and audio (MP3, WAV, OGG, M4A).

    Requires authentication.
    """
    try:
        content, filename, mime_type, file_size = await validate_upload_file(file)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    service = MediaService(db)

    try:
        media = await service.upload_file(
            content=content,
            filename=filename,
            mime_type=mime_type,
            alt_text=alt_text,
            caption=caption,
            post_id=post_id,
        )
        await db.commit()

        return {
            "id": media.id,
            "filename": media.filename,
            "url": service.get_media_url(media),
            "thumbnail_url": service.get_thumbnail_url(media),
            "file_type": media.file_type,
            "file_size": media.file_size,
            "width": media.width,
            "height": media.height,
            "checksum": media.checksum,
            "message": "File uploaded successfully",
        }
    except FileValidationError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=e.message,
        )


@router.post(
    "/upload/multiple",
    response_model=MultipleMediaUploadResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Upload multiple files",
)
async def upload_multiple_files(
    files: list[UploadFile] = File(..., description="Files to upload"),
    post_id: int | None = Form(default=None, description="Post ID to link all files to"),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
):
    """Upload multiple media files at once.

    Requires authentication.
    """
    service = MediaService(db)
    uploaded = []
    failed = []

    for file in files:
        try:
            content, filename, mime_type, file_size = await validate_upload_file(file)
            media = await service.upload_file(
                content=content,
                filename=filename,
                mime_type=mime_type,
                post_id=post_id,
            )
            uploaded.append({
                "id": media.id,
                "filename": media.filename,
                "url": service.get_media_url(media),
                "thumbnail_url": service.get_thumbnail_url(media),
                "file_type": media.file_type,
                "file_size": media.file_size,
                "width": media.width,
                "height": media.height,
                "checksum": media.checksum,
                "message": "File uploaded successfully",
            })
        except HTTPException as e:
            failed.append({
                "filename": file.filename,
                "error": e.detail,
            })
        except FileValidationError as e:
            failed.append({
                "filename": file.filename,
                "error": e.message,
            })
        except Exception as e:
            failed.append({
                "filename": file.filename,
                "error": str(e),
            })

    await db.commit()

    return {
        "uploaded": uploaded,
        "failed": failed,
        "total_uploaded": len(uploaded),
        "total_failed": len(failed),
    }


@router.get(
    "/stats",
    response_model=StorageStatsResponse,
    summary="Get storage statistics",
)
async def get_storage_stats(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
):
    """Get storage usage statistics.

    Requires authentication.
    """
    service = MediaService(db)
    return await service.get_storage_stats()


@router.get(
    "/orphaned",
    response_model=OrphanedMediaResponse,
    summary="List orphaned media",
)
async def list_orphaned_media(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
):
    """List all orphaned media files (not linked to any post).

    Requires authentication.
    """
    service = MediaService(db)
    orphaned, total, total_size = await service.get_orphaned_media()

    return {
        "media": [media_to_list_item(m, service) for m in orphaned],
        "total": total,
        "total_size_bytes": total_size,
    }


@router.delete(
    "/orphaned",
    response_model=BulkDeleteResponse,
    summary="Delete all orphaned media",
)
async def delete_orphaned_media(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
):
    """Delete all orphaned media files.

    This action cannot be undone.
    Requires authentication.
    """
    service = MediaService(db)
    deleted_count, freed_bytes = await service.cleanup_orphaned()
    await db.commit()

    return {
        "message": f"Deleted {deleted_count} orphaned files",
        "deleted_count": deleted_count,
        "failed_count": 0,
        "freed_bytes": freed_bytes,
    }


@router.get(
    "/{media_id}",
    response_model=MediaResponse,
    summary="Get media by ID",
)
async def get_media(
    media_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
):
    """Get a media file by ID.

    Requires authentication.
    """
    service = MediaService(db)
    media = await service.get_media_by_id(media_id)

    if not media:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Media not found",
        )

    return media_to_response(media, service)


@router.patch(
    "/{media_id}",
    response_model=MediaResponse,
    summary="Update media metadata",
)
async def update_media(
    media_id: int,
    update_data: MediaUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
):
    """Update media metadata (alt_text, caption, post_id).

    Requires authentication.
    """
    service = MediaService(db)
    media = await service.update_media(
        media_id=media_id,
        alt_text=update_data.alt_text,
        caption=update_data.caption,
        post_id=update_data.post_id,
    )

    if not media:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Media not found",
        )

    await db.commit()
    return media_to_response(media, service)


@router.delete(
    "/{media_id}",
    response_model=MediaDeleteResponse,
    summary="Delete media",
)
async def delete_media(
    media_id: int,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_auth),
):
    """Delete a media file.

    This removes both the database record and the physical file.
    This action cannot be undone.
    Requires authentication.
    """
    service = MediaService(db)
    success, freed_bytes = await service.delete_media(media_id)

    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Media not found",
        )

    await db.commit()

    return {
        "message": "Media deleted successfully",
        "deleted_count": 1,
        "freed_bytes": freed_bytes,
    }
