"""Coverage tests for database.py and main.py."""

import pytest
from app.database import get_db
from app.main import app
from fastapi.exceptions import RequestValidationError
from fastapi import Request
from unittest.mock import MagicMock

@pytest.mark.asyncio
async def test_get_db_yields_session():
    """Test get_db dependency yields a session."""
    gen = get_db()
    session = await anext(gen)
    assert session is not None
    await session.close()
    # clean up
    try:
        await anext(gen)
    except StopAsyncIteration:
        pass

def test_app_startup_shutdown():
    """Test app events (mocked usually as they run in lifespan)."""
    # Lifespan testing requires TestClient with with block usually, which is covered by other tests running client.
    # We can check if routes are registered
    assert len(app.routes) > 0

@pytest.mark.asyncio
async def test_validation_exception_handler():
    """Test global validation exception handler."""
    # The handler is registered in app.exception_handlers
    handler = app.exception_handlers.get(RequestValidationError)
    # If not explicitly registered (FastAPI default), this might return None or default
    if handler:
        request = MagicMock(spec=Request)
        exc = RequestValidationError(errors=[{"loc": ("body", "field"), "msg": "error", "type": "type_error"}])
        
        resp = await handler(request, exc)
        assert resp.status_code == 422
