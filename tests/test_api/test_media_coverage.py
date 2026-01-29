"""Additional tests for app/api/media.py coverage."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.media import Media, FileType
from app.models.user import User
from app.models.session import Session
from app.services.auth_service import hash_token
from datetime import datetime, timedelta
import io

@pytest.fixture
async def admin_auth_headers(client: AsyncClient, db: AsyncSession):
    user = User(username="media_admin", email="ma@test.com", password_hash="hash", display_name="MediaAdmin")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    session = Session(
        user_id=user.id, 
        token=hash_token("media-token"), 
        expires_at=datetime.utcnow() + timedelta(days=1),
        ip_address="127.0.0.1",
        user_agent="test"
    )
    db.add(session)
    await db.commit()
    return {"Cookie": "session_token=media-token"}

@pytest.mark.asyncio
async def test_upload_media_validation(client: AsyncClient, admin_auth_headers):
    """Test upload validation errors."""
    # Too large (mock config if possible, or just huge file)
    # Invalid extension
    files = {'file': ('test.xyz', io.BytesIO(b"test"), 'application/octet-stream')}
    resp = await client.post("/api/media/upload", files=files, headers=admin_auth_headers)
    assert resp.status_code == 400
    
    # Missing filename handled by FastAPI/validators usually

@pytest.mark.asyncio
async def test_delete_media_not_found(client: AsyncClient, admin_auth_headers):
    """Test deleting non-existent media."""
    resp = await client.delete("/api/media/99999", headers=admin_auth_headers)
    assert resp.status_code == 404

@pytest.mark.asyncio
async def test_update_media_metadata(client: AsyncClient, admin_auth_headers, db: AsyncSession):
    """Test updating media metadata."""
    m = Media(filename="u.jpg", original_path="u.jpg", file_type=FileType.IMAGE, mime_type="i/j", file_size=10, checksum="c")
    db.add(m)
    await db.commit()
    
    data = {"alt_text": "Updated Alt", "caption": "Updated Caption"}
    resp = await client.patch(f"/api/media/{m.id}", json=data, headers=admin_auth_headers)
    assert resp.status_code == 200
    assert resp.json()["alt_text"] == "Updated Alt"

@pytest.mark.asyncio
async def test_list_media_pagination(client: AsyncClient, admin_auth_headers, db: AsyncSession):
    """Test media list pagination."""
    # Create enough items
    media_items = [
        Media(filename=f"{i}.jpg", original_path=f"{i}.jpg", file_type=FileType.IMAGE, mime_type="i/j", file_size=10, checksum=f"c{i}")
        for i in range(15)
    ]
    db.add_all(media_items)
    await db.commit()
    
    resp = await client.get("/api/media/?page=1&per_page=10", headers=admin_auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["items"]) == 10
    assert data["total"] >= 15
    
    resp = await client.get("/api/media/?page=2&per_page=10", headers=admin_auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["items"]) >= 5

@pytest.mark.asyncio
async def test_media_stats(client: AsyncClient, admin_auth_headers):
    """Test media stats endpoint."""
    resp = await client.get("/api/media/stats", headers=admin_auth_headers)
    assert resp.status_code == 200
    assert "total_size_mb" in resp.json()
