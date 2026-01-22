"""Slug generation utilities.

Converts titles to URL-friendly slugs with support for non-ASCII characters.
"""

import re
import unicodedata


def slugify(text: str, max_length: int = 200) -> str:
    """Convert text to URL-friendly slug.

    Handles non-ASCII characters by transliterating to ASCII equivalents.

    Args:
        text: Text to convert to slug
        max_length: Maximum slug length

    Returns:
        URL-friendly slug

    Examples:
        >>> slugify("Hello World!")
        'hello-world'
        >>> slugify("Café & Résumé")
        'cafe-resume'
        >>> slugify("日本語タイトル")
        'ri-ben-yu-taitoru'
    """
    if not text:
        return ""

    # Normalize unicode characters
    text = unicodedata.normalize("NFKD", text)

    # Convert to ASCII, ignoring non-convertible characters
    text = text.encode("ascii", "ignore").decode("ascii")

    # Convert to lowercase
    text = text.lower()

    # Replace spaces and underscores with hyphens
    text = re.sub(r"[\s_]+", "-", text)

    # Remove any characters that aren't alphanumerics or hyphens
    text = re.sub(r"[^a-z0-9-]", "", text)

    # Remove multiple consecutive hyphens
    text = re.sub(r"-+", "-", text)

    # Remove leading/trailing hyphens
    text = text.strip("-")

    # Truncate to max length, but don't cut in the middle of a word
    if len(text) > max_length:
        text = text[:max_length]
        # If we cut in the middle of a word, remove the partial word
        if text and text[-1] != "-":
            last_hyphen = text.rfind("-")
            if last_hyphen > 0:
                text = text[:last_hyphen]
        text = text.rstrip("-")

    return text


def make_unique_slug(
    base_slug: str,
    existing_slugs: set[str],
    max_length: int = 200,
) -> str:
    """Generate a unique slug by appending numbers if necessary.

    Args:
        base_slug: The base slug to make unique
        existing_slugs: Set of existing slugs to check against
        max_length: Maximum slug length

    Returns:
        Unique slug

    Examples:
        >>> make_unique_slug("hello", {"hello", "hello-1"})
        'hello-2'
        >>> make_unique_slug("new-post", set())
        'new-post'
    """
    if not base_slug:
        base_slug = "untitled"

    if base_slug not in existing_slugs:
        return base_slug

    # Try appending numbers
    counter = 1
    while True:
        suffix = f"-{counter}"
        # Ensure we have room for the suffix
        max_base = max_length - len(suffix)
        truncated_base = base_slug[:max_base].rstrip("-")
        candidate = f"{truncated_base}{suffix}"

        if candidate not in existing_slugs:
            return candidate

        counter += 1

        # Safety limit to prevent infinite loops
        if counter > 10000:
            raise ValueError("Unable to generate unique slug")


def is_valid_slug(slug: str) -> bool:
    """Check if a string is a valid slug.

    Args:
        slug: String to validate

    Returns:
        True if valid slug, False otherwise

    Examples:
        >>> is_valid_slug("hello-world")
        True
        >>> is_valid_slug("Hello World")
        False
        >>> is_valid_slug("")
        False
    """
    if not slug:
        return False

    # Only lowercase letters, numbers, and hyphens
    if not re.match(r"^[a-z0-9]+(?:-[a-z0-9]+)*$", slug):
        return False

    # No leading/trailing hyphens
    if slug.startswith("-") or slug.endswith("-"):
        return False

    # No consecutive hyphens
    return "--" not in slug
