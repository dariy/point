"""Template helper functions for Jinja2 templates.

Provides utility functions for checking tag visibility and hierarchy.
"""

from app.models.tag import Tag


def tag_has_hidden_parent(tag: Tag, visited: set[int] | None = None) -> bool:
    """Check if a tag has any ancestor that is hidden (recursive).

    Args:
        tag: Tag to check
        visited: Set of visited tag IDs to prevent infinite loops

    Returns:
        True if any ancestor tag has is_hidden=True
    """
    if visited is None:
        visited = set()

    # Prevent infinite loops in case of circular references
    if tag.id in visited:
        return False
    visited.add(tag.id)

    if not tag.parents:
        return False

    # Check each parent recursively
    for parent in tag.parents:
        if parent.is_hidden:
            return True
        # Recursively check parent's ancestors
        if tag_has_hidden_parent(parent, visited):
            return True

    return False


def tag_has_hidden_posts_parent(tag: Tag, visited: set[int] | None = None) -> bool:
    """Check if a tag or any of its ancestors has is_hidden_posts=True (recursive).

    Args:
        tag: Tag to check
        visited: Set of visited tag IDs to prevent infinite loops

    Returns:
        True if tag or any ancestor has is_hidden_posts=True
    """
    if visited is None:
        visited = set()

    # Prevent infinite loops in case of circular references
    if tag.id in visited:
        return False
    visited.add(tag.id)

    # Check the tag itself
    if tag.is_hidden_posts:
        return True

    if not tag.parents:
        return False

    # Check each parent recursively
    for parent in tag.parents:
        if parent.is_hidden_posts:
            return True
        # Recursively check parent's ancestors
        if tag_has_hidden_posts_parent(parent, visited):
            return True

    return False


def post_has_hidden_posts_tag(post) -> bool:
    """Check if a post has any tag (or parent tag) with is_hidden_posts=True.

    Args:
        post: Post to check

    Returns:
        True if any tag or parent tag has is_hidden_posts=True
    """
    if not post.tags:
        return False

    for tag in post.tags:
        if tag.is_hidden_posts:
            return True
        if tag.parents and any(parent.is_hidden_posts for parent in tag.parents):
            return True

    return False
