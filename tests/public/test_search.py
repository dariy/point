"""Tests for post search functionality."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession


@pytest.mark.asyncio
async def test_search_page_loads(client: AsyncClient, db: AsyncSession) -> None:
    """Test that the homepage loads with a search query."""
    # Note: Search filtering is currently not implemented in the homepage route,
    # but we verify that providing a query parameter doesn't break the page.
    response = await client.get("/?q=Python")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
