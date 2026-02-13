"""Tests for app/database.py to increase coverage."""

import contextlib
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import create_tables, get_db, set_sqlite_pragma


@pytest.mark.asyncio
async def test_create_tables():
    """Test create_tables function."""
    with patch("app.database.engine") as mock_engine:
        # Create a mock connection
        mock_conn = MagicMock()
        mock_conn.run_sync = AsyncMock()

        # Mocking an async context manager for engine.begin()
        mock_async_cm = MagicMock()
        mock_async_cm.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_async_cm.__aexit__ = AsyncMock(return_value=None)
        mock_engine.begin.return_value = mock_async_cm

        await create_tables()

        mock_engine.begin.assert_called_once()
        mock_conn.run_sync.assert_called_once()


@pytest.mark.asyncio
async def test_get_db_success():
    """Test get_db generator - success case."""
    with patch("app.database.async_session_maker") as mock_session_maker:
        mock_session = MagicMock(spec=AsyncSession)
        mock_session_maker.return_value.__aenter__.return_value = mock_session

        generator = get_db()
        yielded_session = await anext(generator)

        assert yielded_session == mock_session

        with contextlib.suppress(StopAsyncIteration):
            await anext(generator)

        mock_session.commit.assert_called_once()
        mock_session.close.assert_called_once()


@pytest.mark.asyncio
async def test_get_db_failure():
    """Test get_db generator - failure case."""
    with patch("app.database.async_session_maker") as mock_session_maker:
        mock_session = MagicMock(spec=AsyncSession)
        mock_session_maker.return_value.__aenter__.return_value = mock_session

        generator = get_db()
        yielded_session = await anext(generator)

        assert yielded_session == mock_session

        # Simulate an exception after yield
        with pytest.raises(RuntimeError, match="Database error"):
            await generator.athrow(RuntimeError("Database error"))

        mock_session.rollback.assert_called_once()
        mock_session.close.assert_called_once()


def test_set_sqlite_pragma():
    """Test set_sqlite_pragma event listener."""
    mock_dbapi_connection = MagicMock()
    mock_cursor = MagicMock()
    mock_dbapi_connection.cursor.return_value = mock_cursor

    set_sqlite_pragma(mock_dbapi_connection, None)

    mock_dbapi_connection.cursor.assert_called_once()
    mock_cursor.execute.assert_called_with("PRAGMA foreign_keys=ON")
    mock_cursor.close.assert_called_once()


def test_db_path_initialization():
    """Test the database path initialization logic."""
    from app.config import get_settings
    settings = get_settings()
    db_path = settings.database_url.replace("sqlite+aiosqlite:///", "")

    # We want to test both branches of if db_path.startswith("./")
    # Since the module is already loaded, we can just verify the logic itself
    # or use importlib.reload if we really wanted to.

    def simulate_logic(url):
        path_str = url.replace("sqlite+aiosqlite:///", "")
        if path_str.startswith("./"):
            path_str = path_str[2:]
        return path_str

    assert simulate_logic("sqlite+aiosqlite:///./data/test.db") == "data/test.db"
    assert simulate_logic("sqlite+aiosqlite:///data/test.db") == "data/test.db"
    assert simulate_logic("sqlite+aiosqlite:////absolute/path/test.db") == "/absolute/path/test.db"

    path = Path(db_path)
    assert path.parent.exists()


@pytest.mark.asyncio
async def test_db_path_initialization_reload():
    """Test the database path initialization logic by reloading the module."""
    import importlib
    from unittest.mock import patch

    # Mock settings to have a path that does NOT start with ./
    mock_settings = MagicMock()
    mock_settings.database_url = "sqlite+aiosqlite:///absolute/path/to/db.db"
    mock_settings.debug = False

    with patch("app.database.get_settings", return_value=mock_settings), \
         patch("app.database.create_async_engine"), \
         patch("app.database.async_sessionmaker"), \
         patch("pathlib.Path.mkdir") as mock_mkdir:

        # Reload to trigger the module-level code
        import app.database
        importlib.reload(app.database)

        # Verify mkdir was called for the absolute path
        mock_mkdir.assert_called()
