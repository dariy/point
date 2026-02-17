"""Tag schemas for request/response validation.

Defines Pydantic models for tag CRUD operations.
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class TagBase(BaseModel):
    """Base tag schema with common fields."""

    name: str = Field(..., min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=1000)
    custom_url: str | None = Field(default=None, max_length=200)
    is_important: bool = Field(default=False)
    is_featured: bool = Field(default=False)
    show_related_tags_as_children: bool = Field(default=False)
    is_hidden: bool = Field(default=False)
    is_hidden_posts: bool = Field(default=False)
    include_in_breadcrumbs: bool = Field(default=True)


class TagLocationBase(BaseModel):
    """Base schema for tag locations."""

    latitude: float
    longitude: float


class TagLocationResponse(TagLocationBase):
    """Schema for tag location response."""

    id: int

    model_config = ConfigDict(from_attributes=True)


class TagCreate(TagBase):
    """Schema for creating a tag."""

    slug: str | None = Field(default=None, min_length=1, max_length=100)
    parent_ids: list[int] = Field(default_factory=list)
    child_ids: list[int] = Field(default_factory=list)
    locations: list[TagLocationBase] = Field(default_factory=list)

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "name": "Travel",
                "slug": "travel-tips",
                "description": "Posts about travel and adventures",
                "is_important": True,
                "is_featured": False,
                "is_hidden": False,
                "is_hidden_posts": False,
                "show_related_tags_as_children": False,
                "parent_ids": [],
                "child_ids": [],
            }
        }
    )


class TagUpdate(BaseModel):
    """Schema for updating a tag (all fields optional)."""

    name: str | None = Field(default=None, min_length=1, max_length=100)
    slug: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=1000)
    custom_url: str | None = Field(default=None, max_length=200)
    is_important: bool | None = Field(default=None)
    is_featured: bool | None = Field(default=None)
    show_related_tags_as_children: bool | None = Field(default=None)
    is_hidden: bool | None = Field(default=None)
    is_hidden_posts: bool | None = Field(default=None)
    include_in_breadcrumbs: bool | None = Field(default=None)
    parent_ids: list[int] | None = Field(default=None)
    child_ids: list[int] | None = Field(default=None)
    locations: list[TagLocationBase] | None = Field(default=None)


class TagListItem(BaseModel):
    """Schema for tag in list view (lighter response)."""

    id: int
    name: str
    slug: str
    is_important: bool
    is_hidden: bool
    is_hidden_posts: bool
    include_in_breadcrumbs: bool
    post_count: int
    locations: list[TagLocationResponse] = Field(default_factory=list)


class TagResponse(BaseModel):
    """Schema for tag response."""

    id: int
    name: str
    slug: str
    description: str | None
    custom_url: str | None
    is_important: bool
    is_featured: bool
    is_hidden: bool
    is_hidden_posts: bool
    include_in_breadcrumbs: bool
    show_related_tags_as_children: bool
    post_count: int
    created_at: datetime
    url: str = Field(description="Computed URL for the tag")
    parents: list[TagListItem] = Field(default_factory=list)
    children: list[TagListItem] = Field(default_factory=list)
    locations: list[TagLocationResponse] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class TagListResponse(BaseModel):
    """Schema for paginated tag list response."""

    tags: list[TagListItem]
    total: int


class TagCloudItem(BaseModel):
    """Schema for tag cloud item with weight."""

    id: int
    name: str
    slug: str
    post_count: int
    weight: float = Field(description="Relative weight for tag cloud display (0-1)")


class TagCloudResponse(BaseModel):
    """Schema for tag cloud response."""

    tags: list[TagCloudItem]


class PostInTag(BaseModel):
    """Schema for post in tag's post list (lightweight)."""

    id: int
    title: str
    slug: str
    excerpt: str | None
    published_at: datetime | None
    thumbnail_path: str | None

    model_config = ConfigDict(from_attributes=True)


class TagWithPostsResponse(BaseModel):
    """Schema for tag with its posts."""

    id: int
    name: str
    slug: str
    description: str | None
    custom_url: str | None
    is_important: bool
    is_featured: bool
    is_hidden: bool
    is_hidden_posts: bool
    include_in_breadcrumbs: bool
    post_count: int
    created_at: datetime
    posts: list[PostInTag]
    total_posts: int
    page: int
    per_page: int
    pages: int

    model_config = ConfigDict(from_attributes=True)
