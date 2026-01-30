"""Extended coverage tests for Tags API."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from unittest.mock import MagicMock, patch

from app.models.tag import Tag
from app.models.post import Post, PostStatus, PostFormatter
from app.models.user import User

@pytest.mark.asyncio
async def test_create_tag_value_error(client: AsyncClient, auth_cookies: dict):
    """Test create tag with ValueError (e.g. invalid name)."""
    with patch("app.services.tag_service.TagService.create_tag") as mock_create:
        mock_create.side_effect = ValueError("Invalid tag name")
        
        response = await client.post(
            "/api/tags",
            json={"name": "New Tag"},
            cookies=auth_cookies
        )
        assert response.status_code == 409
        assert "Invalid tag name" in response.json()["detail"]

@pytest.mark.asyncio
async def test_update_tag_not_found(client: AsyncClient, auth_cookies: dict):
    """Test update tag not found."""
    with patch("app.services.tag_service.TagService.update_tag") as mock_update:
        mock_update.return_value = None
        
        response = await client.put(
            "/api/tags/999",
            json={"name": "Updated"},
            cookies=auth_cookies
        )
        assert response.status_code == 404

@pytest.mark.asyncio
async def test_update_tag_value_error(client: AsyncClient, auth_cookies: dict):
    """Test update tag conflict."""
    with patch("app.services.tag_service.TagService.update_tag") as mock_update:
        mock_update.side_effect = ValueError("Tag exists")
        
        response = await client.put(
            "/api/tags/1",
            json={"name": "Updated"},
            cookies=auth_cookies
        )
        assert response.status_code == 409

@pytest.mark.asyncio
async def test_delete_tag_not_found(client: AsyncClient, auth_cookies: dict):
    """Test delete tag not found."""
    with patch("app.services.tag_service.TagService.delete_tag") as mock_delete:
        mock_delete.return_value = False
        
        response = await client.delete("/api/tags/999", cookies=auth_cookies)
        assert response.status_code == 404

@pytest.mark.asyncio
async def test_get_tag_by_id_not_found(client: AsyncClient):
    """Test get tag by ID not found."""
    response = await client.get("/api/tags/999")
    assert response.status_code == 404

@pytest.mark.asyncio
async def test_get_tag_by_slug_not_found(client: AsyncClient):
    """Test get tag by slug not found."""
    response = await client.get("/api/tags/slug/invalid-slug")
    assert response.status_code == 404

@pytest.mark.asyncio
async def test_get_posts_by_tag_not_found(client: AsyncClient):
    """Test get posts by tag slug not found."""
    response = await client.get("/api/tags/invalid-slug/posts")
    assert response.status_code == 404

@pytest.mark.asyncio
async def test_get_posts_by_tag_pagination(client: AsyncClient, db: AsyncSession):
    """Test pagination for get posts by tag."""
    tag = Tag(name="T1", slug="t1")
    db.add(tag)
    await db.commit()
    
    # Add posts
    for i in range(15):
        post = Post(title=f"P{i}", slug=f"p{i}", content="c", status=PostStatus.PUBLISHED, formatter=PostFormatter.MARKDOWN, author_id=1)
        post.tags.append(tag)
        db.add(post)
    await db.commit()
    
    response = await client.get(f"/api/tags/{tag.slug}/posts?page=1&per_page=10")
    assert response.status_code == 200
    data = response.json()
    assert len(data["posts"]) == 10
    assert data["pages"] == 2
    
    response = await client.get(f"/api/tags/{tag.slug}/posts?page=2&per_page=10")
    assert response.status_code == 200
    data = response.json()
    assert len(data["posts"]) == 5
