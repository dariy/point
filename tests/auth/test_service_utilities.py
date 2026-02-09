"""Tests for AuthService utility functions.

This module contains unit tests for authentication utility functions.
"""

from app.services.auth_service import verify_password

# =============================================================================
# Utility Function Tests
# =============================================================================


class TestUtilityFunctions:
    """Test cases for utility functions."""

    def test_verify_password_exception(self) -> None:
        """Test verify_password with invalid input."""
        assert verify_password("password", None) is False
        assert verify_password("password", "invalid_hash") is False

    def test_verify_password_empty_string(self) -> None:
        """Test verify_password with empty strings."""
        assert verify_password("", "") is False
        assert verify_password("password", "") is False
