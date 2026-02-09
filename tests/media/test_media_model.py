"""Tests for Media model properties and behavior."""

from app.models.media import FileType, Media


def test_media_model_repr():
    """Test string representation of Media."""
    media = Media(id=1, filename="test.jpg", file_type=FileType.IMAGE)
    assert repr(media) == "<Media(id=1, filename='test.jpg', type='image')>"


def test_media_model_properties():
    """Test model properties."""
    # Image
    m1 = Media(
        file_type=FileType.IMAGE,
        thumbnail_path="thumb.jpg",
        width=100,
        height=200,
        post_id=None,
    )
    assert m1.is_image
    assert not m1.is_video
    assert not m1.is_audio
    assert m1.has_thumbnail
    assert m1.dimensions == (100, 200)
    assert m1.is_orphaned

    # Video
    m2 = Media(
        file_type=FileType.VIDEO,
        thumbnail_path=None,
        width=None,
        height=None,
        post_id=1,
    )
    assert not m2.is_image
    assert m2.is_video
    assert not m2.is_audio
    assert not m2.has_thumbnail
    assert m2.dimensions is None
    assert not m2.is_orphaned

    # Audio
    m3 = Media(file_type=FileType.AUDIO)
    assert m3.is_audio
    assert not m3.is_image
    assert not m3.is_video


def test_media_model_url():
    """Test the simplified URL property."""
    # Standard path
    m1 = Media(original_path="originals/2024/08/test.jpg")
    assert m1.url == "/2024/08/test.jpg"

    # Non-standard path
    m2 = Media(original_path="custom/path/file.png")
    assert m2.url == "/media/custom/path/file.png"
