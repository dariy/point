"""Tests for media renaming and reference updates."""

from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.media import FileType, Media
from app.models.post import Post, PostFormatter, PostStatus
from app.models.session import Session
from app.models.user import User
from app.services.auth_service import hash_token
from app.services.media_service import MediaService


@pytest.fixture
async def auth_headers(client: AsyncClient, db: AsyncSession):
    """Create a user and return auth headers."""
    user = User(
        username="rename_user",
        email="rename@test.com",
        password_hash="hash",
        display_name="Renamer",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    session = Session(
        user_id=user.id,
        token=hash_token("rename-token"),
        expires_at=datetime.now(UTC) + timedelta(days=1),
        ip_address="127.0.0.1",
        user_agent="test",
    )
    db.add(session)
    await db.commit()
    return {"Cookie": "session_token=rename-token"}


@pytest.fixture
def patch_storage(tmp_path):
    """Patch settings.storage_path for tests."""
    with patch("app.main.settings") as mock_settings:
        mock_settings.storage_path = str(tmp_path)
        with patch("app.services.media_service.get_settings") as mock_service_settings:
            mock_service_settings.return_value.storage_path = str(tmp_path)
            # Re-initialize MediaService with patched settings
            yield tmp_path


@pytest.mark.asyncio
async def test_rename_media_service(db: AsyncSession, patch_storage):
    """Test media renaming via service including reference updates."""
    tmp_path = patch_storage
    service = MediaService(db)
    # Ensure service uses the patched path
    service.storage_path = Path(tmp_path)

    # Create directory structure
    date_path = "2024/08"
    orig_dir = tmp_path / "media" / "originals" / date_path
    thumb_dir = tmp_path / "media" / "thumbnails" / date_path
    orig_dir.mkdir(parents=True, exist_ok=True)
    thumb_dir.mkdir(parents=True, exist_ok=True)

    (orig_dir / "old.jpg").write_bytes(b"original")
    (thumb_dir / "old.jpg").write_bytes(b"thumbnail")

    media = Media(
        filename="old.jpg",
        original_path=f"originals/{date_path}/old.jpg",
        thumbnail_path=f"thumbnails/{date_path}/old.jpg",
        file_type=FileType.IMAGE,
        mime_type="image/jpeg",
        file_size=8,
        checksum="dummy_rename",
    )
    db.add(media)

    # Create a post that references this media
    user = User(
        username="testuser",
        email="test@test.com",
        password_hash="hash",
        display_name="Test User",
    )
    db.add(user)
    await db.flush()

    post = Post(
        title="Test Post",
        slug="test-post",
        content="Here is the image: /2024/08/old.jpg\nAnd the old path: /media/originals/2024/08/old.jpg",
        excerpt="Snippet with /2024/08/old.jpg",
        thumbnail_path="/2024/08/old.jpg",
        author_id=user.id,
        formatter=PostFormatter.MARKDOWN,
        status=PostStatus.PUBLISHED,
    )
    db.add(post)
    await db.commit()
    await db.refresh(media)
    await db.refresh(post)

    # Perform rename
    new_filename = "new.jpg"
    updated_media = await service.rename_media(media.id, new_filename)

    assert updated_media.filename == "new.jpg"
    assert updated_media.original_path == f"originals/{date_path}/new.jpg"

    # Verify files on disk
    assert not (orig_dir / "old.jpg").exists()
    assert (orig_dir / "new.jpg").exists()
    assert not (thumb_dir / "old.jpg").exists()
    assert (thumb_dir / "new.jpg").exists()

    # Verify post references
    await db.refresh(post)
    assert "/2024/08/new.jpg" in post.content
    assert "/media/originals/2024/08/new.jpg" in post.content
    assert "/2024/08/old.jpg" not in post.content
    assert "/2024/08/new.jpg" in post.excerpt
    assert post.thumbnail_path == "/2024/08/new.jpg"


@pytest.mark.asyncio
async def test_rename_media_api(
    client: AsyncClient, db: AsyncSession, auth_headers, patch_storage
):
    """Test media renaming via API."""
    tmp_path = patch_storage
    media_dir = tmp_path / "media" / "originals" / "2024" / "08"
    media_dir.mkdir(parents=True, exist_ok=True)
    (media_dir / "api_old.jpg").write_bytes(b"content")

    media = Media(
        filename="api_old.jpg",
        original_path="originals/2024/08/api_old.jpg",
        file_type=FileType.IMAGE,
        mime_type="image/jpeg",
        file_size=7,
        checksum="api_dummy_rename",
    )
    db.add(media)
    await db.commit()

    response = await client.post(
        f"/api/media/{media.id}/rename",
        json={"new_filename": "api_new.jpg"},
        headers=auth_headers,
    )

    assert response.status_code == 200
    assert response.json()["filename"] == "api_new.jpg"
    assert (media_dir / "api_new.jpg").exists()
    assert not (media_dir / "api_old.jpg").exists()


@pytest.mark.asyncio
async def test_rename_media_already_exists(
    client: AsyncClient, db: AsyncSession, auth_headers, patch_storage
):
    """Test error when new filename already exists."""
    tmp_path = patch_storage
    media_dir = tmp_path / "media" / "originals" / "2024" / "08"
    media_dir.mkdir(parents=True, exist_ok=True)
    (media_dir / "file1.jpg").write_bytes(b"content1")
    (media_dir / "file2.jpg").write_bytes(b"content2")

    m1 = Media(
        filename="file1.jpg",
        original_path="originals/2024/08/file1.jpg",
        file_type=FileType.IMAGE,
        mime_type="i/j",
        file_size=8,
        checksum="c_exists",
    )
    db.add(m1)
    await db.commit()

    response = await client.post(
        f"/api/media/{m1.id}/rename",
        json={"new_filename": "file2.jpg"},
        headers=auth_headers,
    )

    assert response.status_code == 400
    assert "already exists" in response.json()["detail"]
