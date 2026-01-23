"""Pydantic schemas package.

Exports all schema models for the application.
"""

from app.schemas.auth import (
    LoginRequest,
    LoginResponse,
    MessageResponse,
    PasswordChangeRequest,
    SessionListResponse,
    SessionResponse,
    UserCreate,
    UserResponse,
)
from app.schemas.media import (
    ALLOWED_EXTENSIONS,
    ALLOWED_MIMES,
    BulkDeleteResponse,
    FileType,
    MediaDeleteResponse,
    MediaListItem,
    MediaListResponse,
    MediaResponse,
    MediaUpdate,
    MediaUploadResponse,
    MultipleMediaUploadResponse,
    OrphanedMediaResponse,
    StorageStatsResponse,
)
from app.schemas.post import (
    PostCreate,
    PostFormatter,
    PostListItem,
    PostListResponse,
    PostResponse,
    PostStatus,
    PostUpdate,
    PreviewLinkResponse,
)
from app.schemas.tag import (
    TagCloudItem,
    TagCloudResponse,
    TagCreate,
    TagListItem,
    TagListResponse,
    TagResponse,
    TagUpdate,
    TagWithPostsResponse,
)

__all__ = [
    # Auth
    "LoginRequest",
    "LoginResponse",
    "MessageResponse",
    "PasswordChangeRequest",
    "SessionListResponse",
    "SessionResponse",
    "UserCreate",
    "UserResponse",
    # Media
    "ALLOWED_EXTENSIONS",
    "ALLOWED_MIMES",
    "BulkDeleteResponse",
    "FileType",
    "MediaDeleteResponse",
    "MediaListItem",
    "MediaListResponse",
    "MediaResponse",
    "MediaUpdate",
    "MediaUploadResponse",
    "MultipleMediaUploadResponse",
    "OrphanedMediaResponse",
    "StorageStatsResponse",
    # Post
    "PostCreate",
    "PostFormatter",
    "PostListItem",
    "PostListResponse",
    "PostResponse",
    "PostStatus",
    "PostUpdate",
    "PreviewLinkResponse",
    # Tag
    "TagCloudItem",
    "TagCloudResponse",
    "TagCreate",
    "TagListItem",
    "TagListResponse",
    "TagResponse",
    "TagUpdate",
    "TagWithPostsResponse",
]
