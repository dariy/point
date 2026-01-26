import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostStatus


class TestPostThumbnail:
    """Test cases for post thumbnail auto-extraction."""

    @pytest.mark.asyncio
    async def test_create_post_extracts_markdown_thumbnail(
        self, client: AsyncClient, auth_cookies: dict
    ):
        """Test thumbnail extraction from Markdown image."""
        post_data = {
            "title": "Markdown Image Post",
            "content": "Here is an image: ![Alt Text](/media/test.jpg)",
            "status": "draft",
        }

        response = await client.post(
            "/api/posts",
            json=post_data,
            cookies=auth_cookies,
        )

        assert response.status_code == 201
        data = response.json()
        assert data["thumbnail_path"] == "/media/test.jpg"

    @pytest.mark.asyncio
    async def test_create_post_extracts_html_thumbnail(
        self, client: AsyncClient, auth_cookies: dict
    ):
        """Test thumbnail extraction from HTML image tag."""
        post_data = {
            "title": "HTML Image Post",
            "content": 'Here is an image: <img src="/media/html.jpg" alt="test">',
            "status": "draft",
            "formatter": "html",
        }

        response = await client.post(
            "/api/posts",
            json=post_data,
            cookies=auth_cookies,
        )

        assert response.status_code == 201
        data = response.json()
        assert data["thumbnail_path"] == "/media/html.jpg"

    @pytest.mark.asyncio
    async def test_create_post_ignores_provided_thumbnail(
        self, client: AsyncClient, auth_cookies: dict
    ):
        """Test that provided thumbnail_path is ignored in favor of content extraction."""
        post_data = {
            "title": "Ignored Thumbnail Post",
            "content": "Content with image: ![img](/media/content.jpg)",
            "status": "draft",
            "thumbnail_path": "/media/ignored.jpg",
        }

        response = await client.post(
            "/api/posts",
            json=post_data,
            cookies=auth_cookies,
        )

        assert response.status_code == 201
        data = response.json()
        # Should match content image, not provided one
        assert data["thumbnail_path"] == "/media/content.jpg"

    @pytest.mark.asyncio
    async def test_update_post_updates_thumbnail(
        self, client: AsyncClient, auth_cookies: dict
    ):
        """Test that updating content updates the thumbnail."""
        # 1. Create post with one image
        post_data = {
            "title": "Update Thumbnail Post",
            "content": "First image: ![img](/media/first.jpg)",
            "status": "draft",
        }
        response = await client.post(
            "/api/posts",
            json=post_data,
            cookies=auth_cookies,
        )
        post_id = response.json()["id"]
        assert response.json()["thumbnail_path"] == "/media/first.jpg"

        # 2. Update content with new image
        update_data = {
            "content": "Second image: ![img](/media/second.jpg)"
        }
        response = await client.put(
            f"/api/posts/{post_id}",
            json=update_data,
            cookies=auth_cookies,
        )
        
        assert response.status_code == 200
        assert response.json()["thumbnail_path"] == "/media/second.jpg"

    @pytest.mark.asyncio
    async def test_update_post_removes_thumbnail(
        self, client: AsyncClient, auth_cookies: dict
    ):
        """Test that removing image from content removes thumbnail."""
        # 1. Create post with image
        post_data = {
            "title": "Remove Thumbnail Post",
            "content": "Image: ![img](/media/exists.jpg)",
            "status": "draft",
        }
        response = await client.post(
            "/api/posts",
            json=post_data,
            cookies=auth_cookies,
        )
        post_id = response.json()["id"]
        assert response.json()["thumbnail_path"] == "/media/exists.jpg"

        # 2. Update content removing image
        update_data = {
            "content": "No image here anymore."
        }
        response = await client.put(
            f"/api/posts/{post_id}",
            json=update_data,
            cookies=auth_cookies,
        )
        
        assert response.status_code == 200
        assert response.json()["thumbnail_path"] is None

    @pytest.mark.asyncio
    async def test_partial_update_preserves_thumbnail(
        self, client: AsyncClient, auth_cookies: dict
    ):
        """Test that partial update (no content change) preserves thumbnail."""
        # 1. Create post with image
        post_data = {
            "title": "Partial Update Post",
            "content": "Image: ![img](/media/keep.jpg)",
            "status": "draft",
        }
        response = await client.post(
            "/api/posts",
            json=post_data,
            cookies=auth_cookies,
        )
        post_id = response.json()["id"]
        assert response.json()["thumbnail_path"] == "/media/keep.jpg"

        # 2. Update title only
        update_data = {
            "title": "New Title"
        }
        response = await client.put(
            f"/api/posts/{post_id}",
            json=update_data,
            cookies=auth_cookies,
        )
        
        assert response.status_code == 200
        assert response.json()["title"] == "New Title"
        # Content didn't change, so extraction didn't run, old value persisted
        assert response.json()["thumbnail_path"] == "/media/keep.jpg"