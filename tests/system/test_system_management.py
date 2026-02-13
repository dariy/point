"""Tests for general system management, monitoring, and infrastructure."""

from pathlib import Path
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.system_service import SystemService


class TestInfrastructureAPI:
    """Test cases for core infrastructure endpoints (health, root, security)."""

    @pytest.mark.asyncio
    async def test_health_status(self, client: AsyncClient) -> None:
        """Test that the health endpoint returns 200 and healthy status."""
        response = await client.get("/health")
        assert response.status_code == 200
        assert response.json()["status"] == "healthy"

    @pytest.mark.asyncio
    async def test_root_access(self, client: AsyncClient) -> None:
        """Test that the root URL returns a 200 response."""
        response = await client.get("/")
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_root_content_type(self, client: AsyncClient) -> None:
        """Test that the root URL returns HTML content."""
        response = await client.get("/")
        assert "text/html" in response.headers["content-type"]

    @pytest.mark.asyncio
    async def test_security_headers_present(self, client: AsyncClient) -> None:
        """Test that common security headers are included in responses."""
        response = await client.get("/")
        assert "X-Content-Type-Options" in response.headers
        assert "X-Frame-Options" in response.headers
        assert "Content-Security-Policy" in response.headers


class TestSystemMonitoringAPI:
    """Test cases for system info and log API endpoints."""

    @pytest.mark.asyncio
    async def test_get_system_stats(self, client: AsyncClient, auth_cookies: dict[str, str]) -> None:
        """Test getting comprehensive system statistics."""
        response = await client.get("/api/system/stats", cookies=auth_cookies)
        assert response.status_code == 200
        data = response.json()
        assert "database_size_kb" in data
        assert "posts_count" in data
        assert "app_version" in data

    @pytest.mark.asyncio
    async def test_get_logs(self, client: AsyncClient, auth_cookies: dict[str, str]) -> None:
        """Test retrieving system logs via API."""
        response = await client.get("/api/system/logs?log_type=app&lines=10", cookies=auth_cookies)
        assert response.status_code == 200
        assert isinstance(response.json(), list)

    @pytest.mark.asyncio
    async def test_system_unauthorized(self, client: AsyncClient) -> None:
        """Test that system management endpoints require authentication."""
        endpoints = [
            ("GET", "/api/system/stats"),
            ("GET", "/api/system/logs"),
            ("POST", "/api/system/cache/clear"),
            ("POST", "/api/system/backup"),
            ("GET", "/api/system/backups"),
        ]
        for method, url in endpoints:
            response = await client.request(method, url)
            assert response.status_code == 401


class TestSystemService:
    """Unit tests for SystemService business logic."""

    @pytest.mark.asyncio
    async def test_get_system_stats_path_variants(self, db: AsyncSession) -> None:
        """Test stats collection with different database path formats."""
        system_service = SystemService(db)

        # Test with relative path
        with patch.object(system_service.settings, "database_url", "sqlite+aiosqlite:///./test.db"):
            stats = await system_service.get_system_stats()
            assert "database_size_kb" in stats

        # Test with absolute path
        with patch.object(system_service.settings, "database_url", "sqlite+aiosqlite:///absolute/path/to/test.db"):
            stats = await system_service.get_system_stats()
            assert "database_size_kb" in stats

    @pytest.mark.asyncio
    async def test_get_logs_error_scenarios(self, db: AsyncSession, tmp_path: Path) -> None:
        """Test log retrieval with missing files and read errors."""
        system_service = SystemService(db)

        # Test file not found
        logs = system_service.get_logs("nonexistent")
        assert any("not found" in line for line in logs)

        # Test read error handling
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        log_file = log_dir / "error.log"
        log_file.write_text("dummy log")

        with patch.object(system_service.settings, "storage_path", str(tmp_path)), \
             patch("builtins.open", side_effect=Exception("Disk failure")):
                logs = system_service.get_logs("error")
                assert any("Error reading log" in line for line in logs)
