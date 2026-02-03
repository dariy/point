"""Tests for media management operations (list, get, update, delete)."""

from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.media import FileType, Media
from app.models.session import Session
from app.models.user import User
from app.services.auth_service import hash_token
from app.services.media_service import MediaService


@pytest.fixture
async def light_auth_headers(client: AsyncClient, db: AsyncSession):
    """Create light user and return auth headers."""
    user = User(username="media_light", email="ma@test.com", password_hash="hash", display_name="Medialight")
    db.add(user)
    await db.commit()
    await db.refresh(user)

    session = Session(
        user_id=user.id,
        token=hash_token("media-token"),
        expires_at=datetime.now(UTC) + timedelta(days=1),
        ip_address="127.0.0.1",
        user_agent="test"
    )
    db.add(session)
    await db.commit()
    return {"Cookie": "session_token=media-token"}


class TestMediaList:
    """Test cases for media list endpoint."""

    @pytest.mark.asyncio
    async def test_list_requires_auth(self, client: AsyncClient) -> None:
        """Test that list requires authentication."""
        response = await client.get("/api/media")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_list_empty(
        self, client: AsyncClient, light_auth_headers: dict
    ) -> None:
        """Test listing media when none exists."""
        response = await client.get(
            "/api/media",
            headers=light_auth_headers,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["media"] == []
        assert data["total"] == 0
        assert data["page"] == 1

    @pytest.mark.asyncio
    async def test_list_with_pagination(
        self, client: AsyncClient, light_auth_headers: dict
    ) -> None:
        """Test list pagination parameters."""
        response = await client.get(
            "/api/media",
            params={"page": 2, "per_page": 5},
            headers=light_auth_headers,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["page"] == 2
        assert data["per_page"] == 5

    @pytest.mark.asyncio
    async def test_list_media_pagination(self, client: AsyncClient, light_auth_headers, db: AsyncSession):
        """Test media list pagination."""
        # Create enough items
        media_items = [
            Media(filename=f"{i}.jpg", original_path=f"{i}.jpg", file_type=FileType.IMAGE, mime_type="i/j", file_size=10, checksum=f"c{i}")
            for i in range(15)
        ]
        db.add_all(media_items)
        await db.commit()

        resp = await client.get("/api/media?page=1&per_page=10", headers=light_auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["media"]) == 10
        assert data["total"] >= 15

        resp = await client.get("/api/media?page=2&per_page=10", headers=light_auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["media"]) >= 5

    @pytest.mark.asyncio
    async def test_list_media_filters(self, db: AsyncSession):
        """Test listing media with filters."""
        service = MediaService(db)
        # Old timestamp to bypass grace period
        old_time = datetime.now(UTC) - timedelta(days=2)

        m1 = Media(filename="1.jpg", original_path="1.jpg", file_type=FileType.IMAGE, mime_type="i/j", file_size=10, checksum="c1", post_id=1, uploaded_at=old_time)
        m2 = Media(filename="2.mp4", original_path="2.mp4", file_type=FileType.VIDEO, mime_type="v/m", file_size=20, checksum="c2", post_id=None, uploaded_at=old_time)
        db.add_all([m1, m2])
        await db.commit()

        # Filter by type
        media, total = await service.list_media(file_type="video")
        assert len(media) == 1
        assert media[0].file_type == FileType.VIDEO

        # Filter by orphaned
        media, total = await service.list_media(orphaned_only=True)
        assert len(media) == 1
        assert media[0].post_id is None

    @pytest.mark.asyncio
    async def test_list_media_orphaned_only(self, db: AsyncSession):
        """Test listing only orphaned media."""
        service = MediaService(db)
        # Orphaned and old
        m1 = await service.upload_file(b"c1", "o.mp4", "video/mp4")
        m1.uploaded_at = datetime.now(UTC) - timedelta(days=2)
        await db.commit()

        items, total = await service.list_media(orphaned_only=True)
        # Compare by ID since objects might be from different sessions
        assert any(item.id == m1.id for item in items)


class TestMediaGet:
    """Test cases for get media endpoint."""

    @pytest.mark.asyncio
    async def test_get_requires_auth(self, client: AsyncClient) -> None:
        """Test that get requires authentication."""
        response = await client.get("/api/media/1")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_get_not_found(
        self, client: AsyncClient, light_auth_headers: dict
    ) -> None:
        """Test getting non-existent media."""
        response = await client.get(
            "/api/media/99999",
            headers=light_auth_headers,
        )

        assert response.status_code == 404


class TestMediaUpdate:
    """Test cases for media update endpoint."""

    @pytest.mark.asyncio
    async def test_update_requires_auth(self, client: AsyncClient) -> None:
        """Test that update requires authentication."""
        response = await client.patch(
            "/api/media/1",
            json={"alt_text": "New alt text"},
        )
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_update_not_found(
        self, client: AsyncClient, light_auth_headers: dict
    ) -> None:
        """Test updating non-existent media."""
        response = await client.patch(
            "/api/media/99999",
            json={"alt_text": "New alt text"},
            headers=light_auth_headers,
        )

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_update_media_metadata(self, client: AsyncClient, light_auth_headers, db: AsyncSession):
        """Test updating media metadata via API."""
        m = Media(filename="u.jpg", original_path="u.jpg", file_type=FileType.IMAGE, mime_type="i/j", file_size=10, checksum="c")
        db.add(m)
        await db.commit()

        data = {"alt_text": "Updated Alt", "caption": "Updated Caption"}
        resp = await client.patch(f"/api/media/{m.id}", json=data, headers=light_auth_headers)
        assert resp.status_code == 200
        assert resp.json()["alt_text"] == "Updated Alt"

    @pytest.mark.asyncio
    async def test_update_media_metadata_service(self, db: AsyncSession):
        """Test updating media metadata via service."""
        service = MediaService(db)
        m = Media(
            filename="test.jpg",
            original_path="p",
            file_type=FileType.IMAGE,
            mime_type="image/jpeg",
            file_size=100,
            checksum="c"
        )
        db.add(m)
        await db.commit()

        updated = await service.update_media(m.id, alt_text="Alt", caption="Cap", post_id=1)
        assert updated is not None
        assert updated.alt_text == "Alt"
        assert updated.caption == "Cap"
        assert updated.post_id == 1

        # Not found
        assert await service.update_media(999) is None


class TestMediaDelete:
    """Test cases for media delete endpoint."""

    @pytest.mark.asyncio
    async def test_delete_requires_auth(self, client: AsyncClient) -> None:
        """Test that delete requires authentication."""
        response = await client.delete("/api/media/1")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_delete_not_found(
        self, client: AsyncClient, light_auth_headers: dict
    ) -> None:
        """Test deleting non-existent media via API."""
        response = await client.delete(
            "/api/media/99999",
            headers=light_auth_headers,
        )

        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_media_not_found(self, client: AsyncClient, light_auth_headers):
        """Test deleting non-existent media."""
        resp = await client.delete("/api/media/99999", headers=light_auth_headers)
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_media_files_exist(self, db: AsyncSession):
        """Test deleting media removes physical files."""
        service = MediaService(db)
        media = await service.upload_file(b"delete me", "del.mp4", "video/mp4")

        # Verify files exist
        original = service.storage_path / "media" / media.original_path
        # Video files don't have thumbnails

        assert original.exists()

        await service.delete_media(media.id)

        assert not original.exists()
