"""Additional tests for app/utils/slugify.py coverage."""

import pytest
from app.utils.slugify import slugify, make_unique_slug, is_valid_slug

def test_slugify_edge_cases():
    assert slugify("") == ""
    assert slugify(None) == ""
    assert slugify("Hello World") == "hello-world"
    # Non-ASCII handled by normalizaton + ascii ignore
    assert slugify("Café") == "cafe"
    # Multiple hyphens and symbols
    assert slugify("Hello!!! --- World???") == "hello-world"
    # Truncation with word boundary
    assert slugify("a-long-slug-that-should-be-truncated", max_length=10) == "a-long"
    assert slugify("alongslugwithout-hyphens", max_length=5) == "along"

def test_make_unique_slug_edge_cases():
    # Empty base
    assert make_unique_slug("", {"untitled"}) == "untitled-1"
    # Truncation for suffix
    assert make_unique_slug("a" * 200, {"a" * 200}, max_length=200) == "a" * 198 + "-1"
    
    # Safety limit
    with pytest.raises(ValueError):
        existing = {f"test-{i}" for i in range(1, 10002)}
        existing.add("test")
        make_unique_slug("test", existing)

def test_is_valid_slug_edge_cases():
    assert is_valid_slug("") is False
    assert is_valid_slug(None) is False
    assert is_valid_slug("valid-slug") is True
    assert is_valid_slug("Invalid-Slug") is False
    assert is_valid_slug("slug-with-space ") is False
    assert is_valid_slug("-leading-hyphen") is False
    assert is_valid_slug("trailing-hyphen-") is False
    assert is_valid_slug("double--hyphen") is False
    assert is_valid_slug("slug.with.dots") is False
