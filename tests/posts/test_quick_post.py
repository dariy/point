"""Integration tests for Quick Post Creation (drag-and-drop) feature.

Tests the complete workflow from image upload to post editor prepopulation.
"""

# Standard library
import io

# Third-party
import pytest
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

# Local
from app.models.media import Media
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService


def create_test_image(width: int = 100, height: int = 100) -> bytes:
    """Create a test image in memory.

    Args:
        width: Image width in pixels
        height: Image height in pixels

    Returns:
        JPEG image as bytes
    """
    image = Image.new("RGB", (width, height), color="red")
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG")
    return buffer.getvalue()


@pytest.fixture
async def test_user(db: AsyncSession) -> dict:
    """Create a test user and return credentials.

    Returns:
        Dict with username, password, and user object
    """
    auth_service = AuthService(db)
    user_data = UserCreate(
        username="quickpost",
        email="quickpost@example.com",
        password="quickpostpass123",
        display_name="Quick Post User",
    )
    user = await auth_service.create_user(user_data)
    await db.commit()
    return {
        "username": "quickpost",
        "password": "quickpostpass123",
        "user": user,
    }


@pytest.fixture
async def auth_cookies(client: AsyncClient, test_user: dict) -> dict:
    """Login and return auth cookies.

    Returns:
        Dict of cookies from login response
    """
    response = await client.post(
        "/api/auth/login",
        json={
            "username": test_user["username"],
            "name": test_user["password"],
        },
    )
    assert response.status_code == 200
    return dict(response.cookies)


class TestQuickPostIntegration:
    """Integration tests for the complete quick post creation workflow."""

    @pytest.mark.asyncio
    async def test_upload_and_redirect_to_editor(
        self, client: AsyncClient, auth_cookies: dict, db: AsyncSession
    ) -> None:
        """Test complete workflow: upload image and verify editor prepopulation."""
        # Step 1: Upload an image
        image_data = create_test_image()
        files = {"file": ("test_quick_post.jpg", image_data, "image/jpeg")}
        upload_response = await client.post(
            "/api/media/upload",
            files=files,
            cookies=auth_cookies,
        )
        assert upload_response.status_code == 201
        upload_data = upload_response.json()
        assert "id" in upload_data
        assert "original_path" in upload_data
        assert "filename" in upload_data
        media_id = upload_data["id"]
        media_path = upload_data["original_path"]
        assert media_path.startswith("originals/")
        editor_response = await client.get(
            f"/light/posts/new?media_id={media_id}&media_path={media_path}",
            cookies=auth_cookies,
        )
        assert editor_response.status_code == 200
        editor_html = editor_response.text
        expected_markdown = f"![](/media/{media_path})"
        assert expected_markdown in editor_html
        assert "/media/originals/originals/" not in editor_html
        assert "/media/originals/" in editor_html
    @pytest.mark.asyncio
    async def test_upload_multiple_images_sequential(
        self, client: AsyncClient, auth_cookies: dict, db: AsyncSession
    ) -> None:
        """Test uploading multiple images sequentially for quick posts."""
        for i in range(3):
            # Upload image
            image_data = create_test_image()
            files = {"file": (f"test_image_{i}.jpg", image_data, "image/jpeg")}
            upload_response = await client.post(
                "/api/media/upload",
                files=files,
                cookies=auth_cookies,
            )
            assert upload_response.status_code == 201
            upload_data = upload_response.json()
            assert "id" in upload_data
            assert "original_path" in upload_data
            editor_response = await client.get(
                f"/light/posts/new?media_id={upload_data['id']}&media_path={upload_data['original_path']}",
                cookies=auth_cookies,
            )
            assert editor_response.status_code == 200
    @pytest.mark.asyncio
    async def test_upload_response_includes_all_required_fields(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test that upload API response includes all fields needed for quick post."""
        image_data = create_test_image()
        files = {"file": ("complete_test.jpg", image_data, "image/jpeg")}
        response = await client.post(
            "/api/media/upload",
            files=files,
            cookies=auth_cookies,
        )
        assert response.status_code == 201
        data = response.json()
        required_fields = ["id", "filename", "original_path", "url", "file_type"]
        for field in required_fields:
            assert field in data, f"Missing required field: {field}"
        assert isinstance(data["original_path"], str)
        assert "/" in data["original_path"]
    @pytest.mark.asyncio
    async def test_editor_without_media_still_works(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test that editor still works normally without quick post parameters."""
        response = await client.get(
            "/light/posts/new",
            cookies=auth_cookies,
        )
        assert response.status_code == 200
        assert "New Post" in response.text
        assert "![](/media/" not in response.text or response.text.count("![](/media/") == 0
    @pytest.mark.asyncio
    async def test_upload_invalid_file_type(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test that invalid file types are rejected during upload."""
        # Try uploading a text file
        files = {"file": ("test.txt", b"This is not an image", "text/plain")}
        response = await client.post(
            "/api/media/upload",
            files=files,
            cookies=auth_cookies,
        )
        assert response.status_code == 400
    @pytest.mark.asyncio
    async def test_media_path_consistency(
        self, client: AsyncClient, auth_cookies: dict, db: AsyncSession
    ) -> None:
        """Test that media path is consistent between database and API response."""
        # Upload image
        image_data = create_test_image()
        files = {"file": ("consistency_test.jpg", image_data, "image/jpeg")}
        upload_response = await client.post(
            "/api/media/upload",
            files=files,
            cookies=auth_cookies,
        )
        assert upload_response.status_code == 201
        api_data = upload_response.json()
        result = await db.execute(
            select(Media).where(Media.id == api_data["id"])
        )
        media = result.scalar_one()
        assert api_data["original_path"] == media.original_path
        assert api_data["filename"] == media.filename
    @pytest.mark.asyncio
    async def test_quick_post_with_png_image(
        self, client: AsyncClient, auth_cookies: dict
    ) -> None:
        """Test quick post creation with PNG image format."""
        # Create PNG image
        image = Image.new("RGBA", (100, 100), color=(255, 0, 0, 255))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        image_data = buffer.getvalue()
        files = {"file": ("test.png", image_data, "image/png")}
        upload_response = await client.post(
            "/api/media/upload",
            files=files,
            cookies=auth_cookies,
        )
        assert upload_response.status_code == 201
        upload_data = upload_response.json()
        editor_response = await client.get(
            f"/light/posts/new?media_id={upload_data['id']}&media_path={upload_data['original_path']}",
            cookies=auth_cookies,
        )
        assert editor_response.status_code == 200
        assert f"![](/media/{upload_data['original_path']})" in editor_response.text
    @pytest.mark.asyncio
    async def test_unauthenticated_upload_fails(
        self, client: AsyncClient
    ) -> None:
        """Test that unauthenticated users cannot upload images."""
        image_data = create_test_image()
        files = {"file": ("test.jpg", image_data, "image/jpeg")}
        response = await client.post(
            "/api/media/upload",
            files=files,
        )
        assert response.status_code == 401
    @pytest.mark.asyncio
    async def test_unauthenticated_editor_access_fails(
        self, client: AsyncClient
    ) -> None:
        """Test that unauthenticated users cannot access editor."""
        response = await client.get(
            "/light/posts/new?media_id=123&media_path=originals/2026/01/test.jpg",
            follow_redirects=False,
        )
        assert response.status_code == 303
        assert response.headers["location"] == "/light/login"