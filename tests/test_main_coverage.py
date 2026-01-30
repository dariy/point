"""Coverage tests for Main Application."""

import pytest
from httpx import AsyncClient
from unittest.mock import MagicMock, patch
from app.main import app, global_exception_handler
from fastapi import Request

@pytest.mark.asyncio
async def test_health_check(client: AsyncClient):
    """Test health check endpoint."""
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}

@pytest.mark.asyncio
async def test_global_exception_handler():
    """Test global exception handler."""
    request = MagicMock(spec=Request)
    exc = Exception("Test error")
    
    # Test with debug=True
    with patch("app.main.settings.debug", True):
        response = await global_exception_handler(request, exc)
        assert response.status_code == 500
        data = url_content = response.body.decode()
        assert "Test error" in data
    
    # Test with debug=False
    with patch("app.main.settings.debug", False):
        response = await global_exception_handler(request, exc)
        assert response.status_code == 500
        data = response.body.decode()
        assert "Internal server error" in data

@pytest.mark.asyncio
async def test_preview_post_endpoint(client: AsyncClient, db):
    """Test preview post endpoint in main.py."""
    from app.models.post import Post, PostStatus, PostFormatter
    from datetime import datetime, timedelta
    
    # Create post with token
    post = Post(
        title="Preview",
        slug="preview",
        content="Content",
        status=PostStatus.DRAFT,
        formatter=PostFormatter.MARKDOWN,
        author_id=1,
        preview_token="token123",
        preview_expires_at=datetime.utcnow() + timedelta(hours=1)
    )
    db.add(post)
    await db.commit()
    
    response = await client.get("/preview/token123")
    assert response.status_code == 200
    assert response.json()["preview_mode"] is True

@pytest.mark.asyncio
async def test_preview_post_invalid_token(client: AsyncClient):
    """Test preview post with invalid token."""
    response = await client.get("/preview/invalid")
    assert response.status_code == 404

@pytest.mark.asyncio
async def test_preview_post_expired(client: AsyncClient, db):
    """Test preview post with expired token."""
    from app.models.post import Post, PostStatus, PostFormatter
    from datetime import datetime, timedelta
    
    post = Post(
        title="Expired",
        slug="expired",
        content="Content",
        status=PostStatus.DRAFT,
        formatter=PostFormatter.MARKDOWN,
        author_id=1,
        preview_token="token_exp",
        preview_expires_at=datetime.utcnow() - timedelta(hours=1)
    )
    db.add(post)
    await db.commit()
    
    response = await client.get("/preview/token_exp")
    assert response.status_code == 410
