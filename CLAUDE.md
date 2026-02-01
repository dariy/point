> **Last Updated**: 2026-01-29
> **Project Status**: Active Development (Feature Rich)
> **Current Phase**: Phase 14 Complete - Enhanced UI/UX

## Table of Contents
1. [Project Overview](#project-overview)
2. [Current Repository State](#current-repository-state)
3. [Architecture & Design Principles](#architecture--design-principles)
4. [Development Workflow](#development-workflow)
5. [Code Conventions](#code-conventions)
6. [Testing Standards](#testing-standards)
7. [Documentation Requirements](#documentation-requirements)
8. [AI Assistant Guidelines](#ai-assistant-guidelines)
9. [Common Tasks & Patterns](#common-tasks--patterns)
10. [Troubleshooting](#troubleshooting)

---

## Project Overview

### What is This Project?

**Photo Blog Engine** is a lightweight, professional-grade personal photo blog platform designed for photographers and visual content creators. The project emphasizes:

- **Simplicity**: Single Docker container deployment
- **Performance**: SQLite database, file-based caching, and AJAX navigation
- **Modern Experience**: Immersive full-screen modes and touch gesture support
- **Self-hosted**: Complete control over data and infrastructure
- **Minimal dependencies**: No Redis, PostgreSQL, or complex microservices

### Technology Stack

```
Backend:     FastAPI (Python 3.12+)
Database:    SQLite (with SQLAlchemy 2.0+)
Templates:   Jinja2
Image Proc:  Pillow (PIL)
Tasks:       APScheduler
Server:      Uvicorn (ASGI)
Auth:        FastAPI security + passlib/bcrypt
Testing:     pytest, pytest-asyncio
Linting:     ruff
Type Check:  mypy
Container:   Docker + docker-compose
Frontend:    Vanilla JS with AJAX navigation & touch support
```

### Key Documentation

- `README.md` - Main project overview and setup guide
- `specification.md` - Complete technical specification
- `phases.md` - Development phases and progress tracking
- `LICENSE` - MIT License
- `CLAUDE.md` - This file (AI assistant guide)

---

## Current Repository State

### Project Phase: Enhanced UI/UX Complete

**Status**: Phases 1-12 and Phase 14 Complete. Core blog, admin interface, and advanced UX features are fully functional.

**Completed Phases**:
- ✅ Phase 1: Project Foundation - Docker, database, project structure
- ✅ Phase 2: Authentication System - User/session models, auth API
- ✅ Phase 3: Post Management Core - Post CRUD, slugs, status management
- ✅ Phase 4: Media Management - File upload, image processing, thumbnails
- ✅ Phase 5: Tag System - Tag CRUD, post-tag relationships
- ✅ Phase 6: Light Interface - Dashboard, post editor, media library, tags manager
- ✅ Phase 7: Public Frontend - Homepage, single post view, gallery
- ✅ Phase 8: RSS & SEO - RSS feed, sitemap, robots.txt, meta tags
- ✅ Phase 9: Theming System - Dark/light modes, system detection
- ✅ Phase 10: Caching & Performance - File-based caching, asset optimization
- ✅ Phase 11: Background Tasks & Backup - Automated backups, session cleanup
- ✅ Phase 12: Settings & System Tools - Blog configuration, log viewer, stats
- ✅ Phase 14: Enhanced UI/UX - Immersive mode, AJAX navigation, gesture support, quick post creation

**Next Steps** (Phase 13):
1. CI/CD Pipeline (GitHub Actions)
2. Production Deployment Hardening
3. Final Quality Assurance

### Repository Structure (Current)

```
point/
├── README.md               # Main project guide
├── CLAUDE.md               # This file (AI assistant guide)
├── LICENSE                 # MIT License
├── Dockerfile             # Docker configuration
├── docker-compose.yml     # Docker Compose setup
├── pyproject.toml         # Python project config
├── specification.md       # Complete technical spec
├── phases.md              # Development phases tracker
├── app/
│   ├── api/               # FastAPI routers (admin, auth, media, posts, public, etc.)
│   ├── models/            # SQLAlchemy models
│   ├── schemas/           # Pydantic schemas
│   ├── services/          # Business logic (auth, backup, cache, post, scheduler, etc.)
│   ├── static/            # CSS, JS assets (main.css, main.js, theme.js, light.css, light.js)
│   ├── templates/         # Jinja2 templates (public, light, macros)
│   └── utils/             # Utility functions
├── tests/                 # Comprehensive test suite
└── scripts/               # Utility scripts (init_db.py, backup.sh, restore.sh)
```

---

## Architecture & Design Principles

### 1. Layered Architecture

```
┌─────────────────────────────────────┐
│   Templates (Jinja2)                │  Presentation
├─────────────────────────────────────┤
│   API Routes (FastAPI)              │  HTTP Layer
├─────────────────────────────────────┤
│   Services (Business Logic)         │  Business Layer
├─────────────────────────────────────┤
│   Models (SQLAlchemy)               │  Data Layer
├─────────────────────────────────────┤
│   Database (SQLite)                 │  Storage
└─────────────────────────────────────┘
```

**Important**: Always respect layer boundaries. API routes should call services, not models directly.

### 2. Async-First Design

- Use `async/await` throughout the application
- All API endpoints should be async
- Database operations use async SQLAlchemy
- File I/O should use `aiofiles`

**Example**:
```python
# ✅ CORRECT
async def get_posts(db: AsyncSession, skip: int = 0, limit: int = 10):
    result = await db.execute(select(Post).offset(skip).limit(limit))
    return result.scalars().all()

# ❌ WRONG
def get_posts(db: Session, skip: int = 0, limit: int = 10):
    return db.query(Post).offset(skip).limit(limit).all()
```

### 3. Type Safety

- Use type hints for all functions and methods
- Leverage Pydantic for data validation
- Run `mypy` for type checking
- No `# type: ignore` without justification

**Example**:
```python
from typing import List, Optional
from pydantic import BaseModel

class PostCreate(BaseModel):
    title: str
    content: str
    tags: List[str] = []
    status: str = "draft"

async def create_post(
    post: PostCreate,
    db: AsyncSession
) -> Post:
    # Implementation
    pass
```

### 4. Security First

**Critical Security Rules**:
- ✅ **Always** hash passwords (bcrypt/Argon2)
- ✅ **Always** validate file uploads (type, size, content)
- ✅ **Always** use parameterized queries (SQLAlchemy ORM)
- ✅ **Always** escape output in templates
- ✅ **Never** store secrets in code or git
- ✅ **Never** use raw SQL queries
- ✅ **Never** trust user input

See `specification.md` lines 874-907 for complete security guidelines.

### 5. Single Container Philosophy

- Keep everything in one Docker container
- No Redis, PostgreSQL, or external services
- File-based caching (not in-memory distributed)
- In-process task scheduling (APScheduler)
- Target image size: ~200MB

---

## Development Workflow

### Branch Strategy

**Main Branch**: `main` (production-ready code)

**Feature Branches**: `claude/claude-md-<session-id>-<unique-hash>`
- Example: `claude/claude-md-mkprfvyhx1sh19yh-glNXo`

**Workflow**:
1. Create feature branch from `main`
2. Implement feature with tests
3. Commit with descriptive messages
4. Push to feature branch
5. Create pull request
6. CI runs tests and linting
7. Merge after review

### Commit Messages

Follow conventional commits:

```
feat: add user authentication system
fix: resolve image upload timeout issue
docs: update API documentation
test: add tests for post service
refactor: simplify media processing pipeline
chore: update dependencies
```

**Format**: `<type>: <description>`

**Types**:
- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation
- `test` - Tests
- `refactor` - Code refactoring
- `chore` - Maintenance
- `perf` - Performance improvement

### Git Commands

```bash
# Create and switch to feature branch
git checkout -b claude/claude-md-<session-id>-<hash>

# Stage and commit
git add <files>
git commit -m "feat: descriptive message"

# Push to remote (MUST use -u origin for new branches)
git push -u origin claude/claude-md-<session-id>-<hash>

# Check status
git status
git log --oneline -10
```

**Important**: Branch names MUST start with `claude/` for permissions.

---

## Code Conventions

### Python Style Guide

**Follow PEP 8** with these additions:

1. **Line Length**: 88 characters (Black default)
2. **Imports**: Organize as stdlib → third-party → local
3. **Docstrings**: Google style for all public functions
4. **Naming**:
   - Classes: `PascalCase`
   - Functions/variables: `snake_case`
   - Constants: `UPPER_SNAKE_CASE`
   - Private: `_leading_underscore`

**Example**:
```python
"""Module for post management services."""

from typing import List, Optional
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.post import Post
from app.schemas.post import PostCreate, PostUpdate


class PostService:
    """Service for managing blog posts.

    Handles CRUD operations, slug generation, and status transitions.
    """

    def __init__(self, db: AsyncSession):
        """Initialize post service.

        Args:
            db: Async database session
        """
        self.db = db

    async def create_post(
        self,
        post_data: PostCreate,
        author_id: int
    ) -> Post:
        """Create a new blog post.

        Args:
            post_data: Post creation data
            author_id: ID of the post author

        Returns:
            Created post instance

        Raises:
            ValueError: If slug already exists
        """
        # Implementation
        pass
```

### Database Models

**Location**: `app/models/`

**Conventions**:
- One model per file
- Use SQLAlchemy 2.0+ declarative style
- Include `__repr__` for debugging
- Add indexes for frequently queried fields
- Use timezone-aware timestamps

**Example**:
```python
from datetime import datetime
from typing import Optional

from sqlalchemy import String, Text, DateTime, Integer, Boolean
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Post(Base):
    """Blog post model."""

    __tablename__ = "posts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    slug: Mapped[str] = mapped_column(
        String(200),
        unique=True,
        index=True,
        nullable=False
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        String(20),
        default="draft",
        index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=datetime.utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=datetime.utcnow,
        onupdate=datetime.utcnow
    )

    def __repr__(self) -> str:
        return f"<Post(id={self.id}, title='{self.title}', status='{self.status}')>"
```

### Pydantic Schemas

**Location**: `app/schemas/`

**Conventions**:
- Separate schemas for Create, Update, Response
- Use `ConfigDict` for ORM mode
- Add field validation
- Include examples for documentation

**Example**:
```python
from typing import Optional, List
from datetime import datetime
from pydantic import BaseModel, Field, ConfigDict


class PostBase(BaseModel):
    """Base post schema."""
    title: str = Field(..., min_length=1, max_length=500)
    content: str
    excerpt: Optional[str] = None
    status: str = Field(default="draft", pattern="^(draft|published|hidden)$")


class PostCreate(PostBase):
    """Schema for creating a post."""
    tags: List[str] = Field(default_factory=list)

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "title": "My First Photo Journey",
                "content": "Today I captured...",
                "status": "draft",
                "tags": ["travel", "landscape"]
            }
        }
    )


class PostResponse(PostBase):
    """Schema for post response."""
    id: int
    slug: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
```

### API Routes

**Location**: `app/api/`

**Conventions**:
- One router per resource (posts, tags, media)
- Use dependency injection for auth
- Include response models
- Add OpenAPI documentation
- Handle errors gracefully

**Example**:
```python
from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.schemas.post import PostCreate, PostResponse
from app.services.post_service import PostService
from app.dependencies import get_current_user

router = APIRouter(prefix="/api/posts", tags=["posts"])


@router.post(
    "/",
    response_model=PostResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new post"
)
async def create_post(
    post_data: PostCreate,
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user)
):
    """Create a new blog post.

    Requires authentication. The post will be created as a draft
    by default unless status is explicitly set.
    """
    service = PostService(db)
    try:
        post = await service.create_post(post_data, current_user.id)
        return post
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
```

### Error Handling

**Standard HTTP Status Codes**:
- `200 OK` - Successful GET/PUT/PATCH
- `201 Created` - Successful POST
- `204 No Content` - Successful DELETE
- `400 Bad Request` - Invalid input
- `401 Unauthorized` - Not authenticated
- `403 Forbidden` - Authenticated but not authorized
- `404 Not Found` - Resource doesn't exist
- `409 Conflict` - Resource conflict (duplicate slug)
- `422 Unprocessable Entity` - Validation error
- `500 Internal Server Error` - Server error

**Error Response Format**:
```json
{
  "detail": "Human-readable error message",
  "error_code": "RESOURCE_NOT_FOUND",
  "field": "slug"  // Optional
}
```

---

## Testing Standards

### Test Structure

```
tests/
├── __init__.py
├── conftest.py              # Pytest fixtures
├── test_api/
│   ├── __init__.py
│   ├── test_posts.py        # Test post endpoints
│   ├── test_tags.py
│   ├── test_media.py
│   └── test_auth.py
├── test_services/
│   ├── __init__.py
│   ├── test_post_service.py
│   ├── test_media_service.py
│   └── test_auth_service.py
└── test_models/
    ├── __init__.py
    └── test_post.py
```

### Testing Requirements

**Coverage Goals**:
- Overall: 80%+ coverage
- Critical paths (auth, file upload): 100%
- Services: 90%+
- API routes: 85%+

**Test Types**:
1. **Unit Tests** - Test individual functions/methods
2. **Integration Tests** - Test API endpoints with database
3. **E2E Tests** (Optional Phase 2) - Full user journeys

### Test Conventions

**Naming**: `test_<function>_<scenario>_<expected>`

**Example**:
```python
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.main import app
from app.models.post import Post


class TestPostAPI:
    """Test cases for post API endpoints."""

    @pytest.mark.asyncio
    async def test_create_post_with_valid_data_returns_201(
        self,
        client: AsyncClient,
        db: AsyncSession,
        auth_headers: dict
    ):
        """Test successful post creation."""
        # Arrange
        post_data = {
            "title": "Test Post",
            "content": "Test content",
            "status": "draft"
        }

        # Act
        response = await client.post(
            "/api/posts",
            json=post_data,
            headers=auth_headers
        )

        # Assert
        assert response.status_code == 201
        data = response.json()
        assert data["title"] == post_data["title"]
        assert "id" in data
        assert "slug" in data

    @pytest.mark.asyncio
    async def test_create_post_without_auth_returns_401(
        self,
        client: AsyncClient
    ):
        """Test post creation without authentication."""
        # Arrange
        post_data = {"title": "Test", "content": "Content"}

        # Act
        response = await client.post("/api/posts", json=post_data)

        # Assert
        assert response.status_code == 401
```

### Fixtures (conftest.py)

```python
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

from app.main import app
from app.database import Base, get_db


@pytest.fixture
async def db():
    """Create test database."""
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        echo=False
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async_session = sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )

    async with async_session() as session:
        yield session

    await engine.dispose()


@pytest.fixture
async def client(db):
    """Create test client."""
    async def override_get_db():
        yield db

    app.dependency_overrides[get_db] = override_get_db

    async with AsyncClient(app=app, base_url="http://test") as ac:
        yield ac

    app.dependency_overrides.clear()


@pytest.fixture
def auth_headers(test_user):
    """Get auth headers for test user."""
    token = create_access_token(test_user.id)
    return {"Authorization": f"Bearer {token}"}
```

### Running Tests

```bash
# Use the test runner script (not direct pytest)
./tests.sh [path]              # Run tests with coverage (e.g., ./tests.sh tests/posts)
./tests.sh                      # Run all tests in tests/ directory

# Direct pytest commands (if needed)
pytest

# Run with coverage
pytest --cov=app --cov-report=html

# Run specific test file
pytest tests/test_api/test_posts.py

# Run specific test
pytest tests/test_api/test_posts.py::TestPostAPI::test_create_post

# Run with output
pytest -v -s

# Run only failed tests
pytest --lf
```

---

## Documentation Requirements

### Code Documentation

**Docstring Format**: Google Style

```python
def function_name(param1: str, param2: int) -> bool:
    """Short description (one line).

    Longer description if needed. Explain what the function does,
    any important behaviors, side effects, etc.

    Args:
        param1: Description of param1
        param2: Description of param2

    Returns:
        Description of return value

    Raises:
        ValueError: If param1 is empty
        HTTPException: If resource not found

    Example:
        >>> function_name("test", 42)
        True
    """
    pass
```

### API Documentation

- Auto-generated via FastAPI
- Available at `/docs` (Swagger UI)
- Available at `/redoc` (ReDoc)
- Include examples in schemas
- Document all error responses

### README.md (To Be Created)

**Required Sections**:
1. Project overview
2. Features
3. Quick start
4. Installation
5. Configuration
6. Usage examples
7. API documentation link
8. Contributing guidelines
9. License

### CHANGELOG.md (To Be Created)

Follow [Keep a Changelog](https://keepachangelog.com/):

```markdown
# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Initial project setup
- User authentication system

### Changed
- Improved image processing performance

### Fixed
- Resolved slug generation bug

## [0.1.0] - 2026-01-22

### Added
- Project initialization
- Technical specification
```

---

## AI Assistant Guidelines

### General Principles

1. **Understand Before Acting**
   - Read relevant specification sections
   - Check existing code patterns
   - Understand the context fully

2. **Follow the Architecture**
   - Respect layer boundaries
   - Use established patterns
   - Don't introduce unnecessary complexity

3. **Maintain Code Quality**
   - Write tests for new code
   - Follow style guidelines
   - Add proper documentation
   - Run linting before committing

4. **Security Awareness**
   - Always validate user input
   - Never store secrets in code
   - Use secure defaults
   - Think about attack vectors

5. **Communication**
   - Explain what you're doing
   - Ask clarifying questions
   - Document decisions
   - Provide progress updates

### Task Workflow

When given a task, follow this process:

```
1. UNDERSTAND
   ├─ Read specification.md relevant sections
   ├─ Check existing code patterns
   └─ Clarify requirements if needed

2. PLAN
   ├─ Break down into subtasks
   ├─ Identify affected files
   ├─ Consider dependencies
   └─ Plan testing approach

3. IMPLEMENT
   ├─ Write code following conventions
   ├─ Add type hints
   ├─ Include docstrings
   └─ Handle errors properly

4. TEST
   ├─ Write unit tests
   ├─ Run test suite
   ├─ Check coverage
   └─ Test manually if needed

5. DOCUMENT
   ├─ Update docstrings
   ├─ Update README if needed
   ├─ Add comments for complex logic
   └─ Update CHANGELOG

6. COMMIT
   ├─ Stage changes
   ├─ Write clear commit message
   ├─ Push to feature branch
   └─ Create PR if ready
```

### Code Review Checklist

Before committing, verify:

- [ ] Code follows style guide (PEP 8)
- [ ] Type hints on all functions
- [ ] Docstrings on public functions
- [ ] Error handling implemented
- [ ] Security considerations addressed
- [ ] Tests written and passing
- [ ] No hardcoded secrets or credentials
- [ ] No debugging print statements
- [ ] Import statements organized
- [ ] No unused imports or variables

### Common Mistakes to Avoid

❌ **Don't**:
- Skip testing
- Ignore type hints
- Use synchronous code in async context
- Store secrets in code
- Use raw SQL queries
- Ignore errors silently
- Create god objects/functions
- Over-engineer simple solutions
- Skip documentation
- Commit broken code
- Forget 'self' parameter in class-based test methods
- Mix import ordering (always: stdlib → third-party → local)

✅ **Do**:
- Write tests first (TDD when appropriate)
- Use type hints everywhere
- Use async/await consistently
- Use environment variables for config
- Use SQLAlchemy ORM
- Handle and log errors
- Keep functions focused (Single Responsibility)
- Keep it simple (KISS principle)
- Document as you code
- Ensure tests pass before committing
- Use 'self' as first param in test class methods
- Organize imports with comments: # Standard library, # Third-party, # Local

### File Creation Guidelines

When creating new files:

1. **Add proper headers**:
```python
"""Module description.

Longer description if needed explaining the purpose,
key classes, and usage patterns.
"""
```

2. **Organize imports**:
```python
# Standard library
from typing import List, Optional
from datetime import datetime

# Third-party
from fastapi import APIRouter, Depends
from sqlalchemy import select

# Local
from app.models.post import Post
from app.schemas.post import PostCreate
```

3. **Include `__init__.py`**:
- Every package directory needs `__init__.py`
- Can be empty or export public interface

4. **Follow naming conventions**:
- Modules: `snake_case.py`
- Classes: `PascalCase`
- Match file name to main class (e.g., `post_service.py` → `PostService`)

---

## Common Tasks & Patterns

### Task: Adding a New Model

1. Create model file: `app/models/new_model.py`
2. Define SQLAlchemy model with proper types
3. Add to `app/models/__init__.py`
4. Create migration (if using Alembic later)
5. Create Pydantic schemas in `app/schemas/new_model.py`
6. Write model tests in `tests/test_models/test_new_model.py`

### Task: Adding a New API Endpoint

1. Define schema in `app/schemas/`
2. Implement service logic in `app/services/`
3. Create route in `app/api/`
4. Add route to `app/main.py`
5. Write tests in `tests/test_api/`
6. Test manually via `/docs`

### Task: Adding File Upload

1. Create upload schema with file validation
2. Implement processing in `app/services/media_service.py`
3. Add route in `app/api/media.py`
4. Save files to `/data/media/originals/YYYY/MM/`
5. Generate thumbnails
6. Store metadata in database
7. Test with various file types and sizes

### Task: Adding Background Task

1. Define task function in `app/services/`
2. Register with APScheduler in `app/main.py`
3. Add logging
4. Make it idempotent (safe to run multiple times)
5. Add error handling
6. Test manually

### Pattern: Dependency Injection

```python
# app/dependencies.py
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer

security = HTTPBearer()

async def get_current_user(
    token: str = Depends(security),
    db: AsyncSession = Depends(get_db)
) -> User:
    """Get current authenticated user."""
    # Validate token and return user
    pass

# app/api/posts.py
@router.get("/api/posts/me")
async def get_my_posts(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get posts by current user."""
    pass
```

### Pattern: Service Layer

```python
# app/services/post_service.py
class PostService:
    """Business logic for posts."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def create_post(
        self,
        post_data: PostCreate,
        author_id: int
    ) -> Post:
        """Create post with slug generation."""
        slug = await self._generate_unique_slug(post_data.title)

        post = Post(
            title=post_data.title,
            content=post_data.content,
            slug=slug,
            author_id=author_id
        )

        self.db.add(post)
        await self.db.commit()
        await self.db.refresh(post)

        return post

    async def _generate_unique_slug(self, title: str) -> str:
        """Generate unique slug from title."""
        # Implementation
        pass

# app/api/posts.py
@router.post("/api/posts")
async def create_post(
    post_data: PostCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    service = PostService(db)
    return await service.create_post(post_data, current_user.id)
```

### Pattern: Error Handling

```python
from fastapi import HTTPException, status

# Service layer - raise ValueError
async def create_post(self, post_data: PostCreate) -> Post:
    if await self._slug_exists(post_data.slug):
        raise ValueError(f"Slug '{post_data.slug}' already exists")
    # Create post

# API layer - convert to HTTPException
@router.post("/api/posts")
async def create_post(post_data: PostCreate):
    try:
        service = PostService(db)
        return await service.create_post(post_data)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(e)
        )
```

---

## Troubleshooting

### Common Issues

#### Issue: Import errors

**Problem**: `ModuleNotFoundError: No module named 'app'`

**Solution**:
- Ensure you're in the project root
- Check `PYTHONPATH`: `export PYTHONPATH=$PWD`
- Verify virtual environment is activated

#### Issue: Async session errors

**Problem**: `RuntimeError: Event loop is closed`

**Solution**:
- Use `async with` for sessions
- Ensure all DB operations are awaited
- Check for mixing sync/async code

#### Issue: Migration conflicts

**Problem**: Database schema out of sync

**Solution**:
- For development: Drop and recreate DB
- For production: Use proper migrations (Alembic)
- Check `specification.md` for schema definitions

#### Issue: File permissions

**Problem**: Can't write to `/data/` directory

**Solution**:
- Check Docker volume permissions
- Ensure app runs as correct user
- See `specification.md` lines 603-605

#### Issue: Type checking errors

**Problem**: `mypy` reports type errors

**Solution**:
- Add proper type hints
- Use `Optional[T]` for nullable types
- Check SQLAlchemy 2.0+ typing patterns

### Debug Commands

```bash
# Check Python path
python -c "import sys; print('\n'.join(sys.path))"

# Verify imports
python -c "from app.models.post import Post; print('OK')"

# Run single test with output
pytest tests/test_api/test_posts.py -v -s

# Check database
sqlite3 /data/blog.db ".tables"

# View logs
tail -f /data/logs/app.log

# Check container
docker-compose ps
docker-compose logs -f blog
```

### Getting Help

1. **Check specification.md** - Complete technical details
2. **Check this file** - AI assistant guidelines
3. **Search existing code** - Look for similar patterns
4. **Read FastAPI docs** - https://fastapi.tiangolo.com
5. **Read SQLAlchemy docs** - https://docs.sqlalchemy.org

---

## Quick Reference

### File Locations

| Component | Location |
|-----------|----------|
| Main app | `app/main.py` |
| Config | `app/config.py` |
| Database setup | `app/database.py` |
| Models | `app/models/*.py` |
| Schemas | `app/schemas/*.py` |
| API routes | `app/api/*.py` |
| Services | `app/services/*.py` |
| Templates | `app/templates/*.html` |
| Static files | `app/static/` |
| Tests | `tests/` |
| Scripts | `scripts/` |

### Key Commands

```bash
# Development
python -m app.main                    # Run dev server
uvicorn app.main:app --reload         # Run with auto-reload

# Testing
pytest                                # Run all tests
pytest --cov=app                      # Run with coverage
pytest -v -s                          # Verbose output

# Linting
ruff check app/                       # Lint code
ruff format app/                      # Format code
mypy app/                             # Type check

# Docker
docker-compose up -d                  # Start services
docker-compose down                   # Stop services
docker-compose logs -f blog           # View logs
docker-compose exec blog bash         # Shell into container

# Git
git status                            # Check status
git add .                             # Stage all
git commit -m "feat: message"         # Commit
git push -u origin <branch>           # Push
```

### Important Files Reference

| File | Lines | Content |
|------|-------|---------|
| specification.md | 35-122 | Directory structure |
| specification.md | 149-239 | Database schema |
| specification.md | 241-492 | Core features |
| specification.md | 493-546 | Configuration |
| specification.md | 551-682 | Docker setup |
| specification.md | 684-799 | CI/CD pipeline |
| specification.md | 801-872 | API endpoints |
| specification.md | 874-907 | Security |
| specification.md | 909-930 | Testing |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-22 | Initial CLAUDE.md creation |
| 1.1.0 | 2026-01-22 | Phase 1-2 complete: Foundation and Authentication |
| 1.2.0 | 2026-01-23 | Phase 3-5 complete: Posts, Media, Tags |
| 1.3.0 | 2026-01-23 | Phase 6 complete: Light Interface with templates, CSS, JS |

---

**Remember**: This is a living document. Update it as patterns emerge and the project evolves.

For detailed technical specifications, always refer to `specification.md`.

Happy coding! 🚀
