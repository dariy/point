"""Tests for authentication utility functions.

This module contains tests for password hashing, token generation, and verification.
"""

from sqlalchemy.ext.asyncio import AsyncSession
import pytest

from app.services.auth_service import (
    generate_session_token,
    hash_password,
    verify_password,
)


class TestAuthUtilities:
    """Test cases for auth utility functions."""

    @pytest.mark.asyncio
    async def test_password_hashing(self, db: AsyncSession) -> None:
        """Test password hashing and verification."""
        password = "mysecretpassword"
        hashed = hash_password(password)

        assert hashed != password
        assert verify_password(password, hashed)
        assert not verify_password("wrongpassword", hashed)

    @pytest.mark.asyncio
    async def test_session_token_generation(self, db: AsyncSession) -> None:
        """Test session token generation."""
        token1 = generate_session_token()
        token2 = generate_session_token()

        assert len(token1) == 64
        assert token1 != token2

    def test_verify_password_with_invalid_hash(self) -> None:
        """Test verify_password with invalid/None hash."""
        assert verify_password("password", None) is False
        assert verify_password("password", "invalid_hash") is False
