"""Post schemas for request/response validation.

Defines Pydantic models for post CRUD operations.
"""

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class PostStatus(str, Enum):
    """Post publication status."""

    DRAFT = "draft"
    PUBLISHED = "published"
    HIDDEN = "hidden"
    PAGE = "page"


class PostFormatter(str, Enum):
    """Content formatter type."""

    MARKDOWN = "markdown"
    HTML = "html"
    RAW = "raw"


class PostBase(BaseModel):
    """Base post schema with common fields."""

    title: str = Field(..., min_length=1, max_length=500)
    content: str = Field(..., min_length=1)
    excerpt: str | None = Field(default=None, max_length=1000)
    formatter: PostFormatter = Field(default=PostFormatter.MARKDOWN)
    status: PostStatus = Field(default=PostStatus.DRAFT)
    is_featured: bool = Field(default=False)
    thumbnail_path: str | None = Field(default=None, max_length=500)
    meta_description: str | None = Field(default=None, max_length=300)


class PostCreate(PostBase):
    """Schema for creating a post."""

    slug: str | None = Field(default=None, max_length=200, description="Optional explicit slug")
    tags: list[str] = Field(default_factory=list, description="Tag names to associate")

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "title": "My First Photo Journey",
                "content": "# Introduction\n\nToday I captured some amazing shots...",
                "status": "draft",
                "formatter": "markdown",
                "tags": ["travel", "landscape"],
            }
        }
    )


class PostUpdate(BaseModel):
    """Schema for updating a post (all fields optional)."""

    title: str | None = Field(default=None, min_length=1, max_length=500)
    slug: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = Field(default=None, min_length=1)
    excerpt: str | None = Field(default=None, max_length=1000)
    formatter: PostFormatter | None = Field(default=None)
    status: PostStatus | None = Field(default=None)
    is_featured: bool | None = Field(default=None)
    thumbnail_path: str | None = Field(default=None, max_length=500)
    meta_description: str | None = Field(default=None, max_length=300)
    tags: list[str] | None = Field(default=None)


class AuthorResponse(BaseModel):
    """Schema for author information in post response."""

    id: int
    username: str
    display_name: str
    avatar_path: str | None = None

    model_config = ConfigDict(from_attributes=True)


class PostResponse(BaseModel):
    """Schema for post response."""

    id: int
    title: str
    slug: str
    content: str
    content_html: str | None = Field(default=None, description="Rendered HTML content")
    excerpt: str | None
    formatter: PostFormatter
    status: PostStatus
    is_featured: bool
    view_count: int
    published_at: datetime | None
    created_at: datetime
    updated_at: datetime
    author: AuthorResponse
    thumbnail_path: str | None
    meta_description: str | None
    tags: list[str] = Field(default_factory=list)
    media: list[Any] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class PostListItem(BaseModel):
    """Schema for post in list view (lighter than full response)."""

    id: int
    title: str
    slug: str
    excerpt: str | None
    status: PostStatus
    is_featured: bool
    view_count: int
    published_at: datetime | None
    created_at: datetime
    updated_at: datetime
    author: AuthorResponse
    thumbnail_path: str | None
    tags: list[str] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class PostListResponse(BaseModel):
    """Schema for paginated post list response."""

    posts: list[PostListItem]
    total: int
    page: int
    per_page: int
    pages: int


class PreviewLinkResponse(BaseModel):
    """Schema for preview link response."""

    preview_url: str
    expires_at: datetime
    token: str


class PostStatusUpdate(BaseModel):
    """Schema for changing post status."""

    status: PostStatus
