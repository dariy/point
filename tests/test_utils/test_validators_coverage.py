"""Additional tests for app/utils/validators.py coverage."""

import pytest
from app.utils.validators import (
    validate_storage_quota, 
    validate_upload_file, 
    validate_image_content, 
    sanitize_filename,
    FileValidationError
)
from fastapi import UploadFile, HTTPException
import io

def test_validate_storage_quota_exceeded():
    with pytest.raises(FileValidationError) as exc:
        validate_storage_quota(900, 200, quota=1000)
    assert "Storage quota exceeded" in str(exc.value)

@pytest.mark.asyncio
async def test_validate_upload_file_edge_cases():
    # Missing filename
    f1 = UploadFile(file=io.BytesIO(b"data"), filename="")
    with pytest.raises(HTTPException) as exc:
        await validate_upload_file(f1)
    assert exc.value.status_code == 400
    assert "Filename is required" in str(exc.value.detail)
    
    # Validation error (e.g. invalid extension)
    f2 = UploadFile(file=io.BytesIO(b"data"), filename="test.exe")
    # Manually set content_type if needed, or let it guess from filename
    with pytest.raises(HTTPException) as exc:
        await validate_upload_file(f2)
    assert exc.value.status_code == 400
def test_validate_image_content_formats():
    assert validate_image_content(b"\xff\xd8\xff") is True # JPEG
    assert validate_image_content(b"\x89PNG\r\n\x1a\n") is True # PNG
    assert validate_image_content(b"GIF87a") is True # GIF
    assert validate_image_content(b"RIFF\x00\x00\x00\x00WEBP") is True # WEBP
    assert validate_image_content(b"<svg") is True # SVG
    
    with pytest.raises(FileValidationError):
        validate_image_content(b"not an image")

def test_sanitize_filename_edge_cases():
    assert sanitize_filename("simple.jpg") == "simple.jpg"
    assert sanitize_filename("path/to/file.jpg") == "file.jpg"
    assert sanitize_filename("hidden/.file") == "file.file"
    assert sanitize_filename(" spaces .jpg") == "_spaces_.jpg"
    assert sanitize_filename("!!!.jpg") == "file.jpg"
