"""Tests for system endpoints (health check, root)."""

import pytest
from httpx import AsyncClient


class TestHealthEndpoint:
    """Test cases for the /health endpoint."""

    @pytest.mark.asyncio
    async def test_health_returns_200(self, client: AsyncClient) -> None:
        """Test that health endpoint returns 200 OK."""
        response = await client.get("/health")

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_health_returns_healthy_status(self, client: AsyncClient) -> None:
        """Test that health endpoint returns healthy status."""
        response = await client.get("/health")

        data = response.json()
        assert data["status"] == "healthy"


class TestRootEndpoint:
    """Test cases for the root endpoint."""

    @pytest.mark.asyncio
    async def test_root_returns_200(self, client: AsyncClient) -> None:
        """Test that root endpoint returns 200 OK."""
        response = await client.get("/")

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_root_returns_html(self, client: AsyncClient) -> None:
        """Test that root endpoint returns HTML content."""
        response = await client.get("/")

        assert response.status_code == 200
        assert "text/html" in response.headers["content-type"]
        assert "<!DOCTYPE html>" in response.text


class TestSecurityHeaders:
    """Test cases for security headers."""

    @pytest.mark.asyncio
    async def test_security_headers_present(self, client: AsyncClient) -> None:
        """Test that security headers are present in response."""
        response = await client.get("/health")

        assert "x-content-type-options" in response.headers
        assert response.headers["x-content-type-options"] == "nosniff"

        assert "x-frame-options" in response.headers
        assert response.headers["x-frame-options"] == "DENY"

        assert "x-xss-protection" in response.headers

        assert "content-security-policy" in response.headers
