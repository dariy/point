"""Extended coverage tests for Media API."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from unittest.mock import MagicMock, patch

from app.utils.validators import FileValidationError


@pytest.mark.asyncio
async def test_upload_file_validation_error(client: AsyncClient, auth_cookies: dict):
    """Test upload file with validation error."""
    with patch("app.api.media.validate_upload_file") as mock_validate:
        mock_validate.side_effect = Exception("Validation failed")
        
        files = {"file": ("test.jpg", b"content", "image/jpeg")}
        response = await client.post(
            "/api/media/upload",
            files=files,
            cookies=auth_cookies
        )
        assert response.status_code == 400
        assert "Validation failed" in response.json()["detail"]


@pytest.mark.asyncio
async def test_upload_multiple_files_partial_failure(client: AsyncClient, auth_cookies: dict):
    """Test multiple file upload with some failures."""
    
    # We need to mock validate_upload_file to succeed for one and fail for another
    # But files are iterated.
    
    # Let's mock at the service level instead to simulate a deeper error
    # Or mock validate_upload_file side_effect with an iterable
    
    with patch("app.api.media.validate_upload_file") as mock_validate:
        # First call succeeds, second raises
        mock_validate.side_effect = [
            (b"content1", "valid.jpg", "image/jpeg", 100),
            FileValidationError("Invalid file", "file")
        ]
        
        with patch("app.services.media_service.MediaService.upload_file") as mock_upload:
            mock_upload.return_value = MagicMock(
                id=1, filename="valid.jpg", file_type="image", 
                file_size=100, width=100, height=100, checksum="abc"
            )
            
            files = [
                ("files", ("valid.jpg", b"content1", "image/jpeg")),
                ("files", ("invalid.txt", b"content2", "text/plain"))
            ]
            
            response = await client.post(
                "/api/media/upload/multiple",
                files=files,
                cookies=auth_cookies
            )
            
            assert response.status_code == 201
            data = response.json()
            assert data["total_uploaded"] == 1
            assert data["total_failed"] == 1
            assert data["uploaded"][0]["filename"] == "valid.jpg"
            assert data["failed"][0]["filename"] == "invalid.txt"


@pytest.mark.asyncio
async def test_upload_multiple_files_generic_error(client: AsyncClient, auth_cookies: dict):
    """Test multiple file upload with generic error."""
    with patch("app.api.media.validate_upload_file") as mock_validate:
        mock_validate.side_effect = Exception("Unexpected error")
        
        files = [("files", ("error.jpg", b"content", "image/jpeg"))]
        
        response = await client.post(
            "/api/media/upload/multiple",
            files=files,
            cookies=auth_cookies
        )
        
        assert response.status_code == 201
        data = response.json()
        assert data["total_failed"] == 1
        assert "Unexpected error" in data["failed"][0]["error"]


@pytest.mark.asyncio
async def test_upload_file_http_exception(client: AsyncClient, auth_cookies: dict):
    """Test upload file with HTTPException from validator."""
    from fastapi import HTTPException
    
    with patch("app.api.media.validate_upload_file") as mock_validate:
        mock_validate.side_effect = HTTPException(status_code=413, detail="Too large")
        
        files = {"file": ("large.jpg", b"content", "image/jpeg")}
        response = await client.post(
            "/api/media/upload",
            files=files,
            cookies=auth_cookies
        )
        assert response.status_code == 413
        assert "Too large" in response.json()["detail"]


@pytest.mark.asyncio
async def test_upload_file_service_exception(client: AsyncClient, auth_cookies: dict):
    """Test upload file with FileValidationError from service."""
    with patch("app.api.media.validate_upload_file") as mock_validate, \
         patch("app.services.media_service.MediaService.upload_file") as mock_upload:
        
        mock_validate.return_value = (b"c", "f.jpg", "image/jpeg", 10)
        mock_upload.side_effect = FileValidationError("Service invalid", "field")
        
        files = {"file": ("test.jpg", b"content", "image/jpeg")}
        response = await client.post(
            "/api/media/upload",
            files=files,
            cookies=auth_cookies
        )
        # The API catches FileValidationError and converts to 400
        assert response.status_code == 400
        detail = response.json()["detail"]
        assert detail["message"] == "Service invalid"
