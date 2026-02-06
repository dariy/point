#!/usr/bin/env python3
"""Initialize the database.

Creates all tables and optionally creates an initial light user.
"""

import asyncio
import getpass
import hashlib
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.config import get_settings
from app.database import async_session_maker, create_tables, engine
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService


def migrate_legacy_db_name() -> None:
    """Rename legacy blog.db to point.db if it exists and point.db does not."""
    settings = get_settings()
    db_url = settings.database_url
    if "sqlite" not in db_url:
        return

    # Extract path from URL (e.g., sqlite+aiosqlite:////data/point.db -> /data/point.db)
    # Handle both absolute (////) and relative (///) paths
    if "sqlite+aiosqlite:////" in db_url:
        db_path_str = db_url.replace("sqlite+aiosqlite:////", "/")
    else:
        db_path_str = db_url.replace("sqlite+aiosqlite:///", "")

    current_db_path = Path(db_path_str)

    # If current DB already exists, nothing to do
    if current_db_path.exists():
        return

    # Check for legacy DB name in the same directory
    legacy_db_path = current_db_path.parent / "blog.db"

    if legacy_db_path.exists():
        print(f"Migrating legacy database: {legacy_db_path} -> {current_db_path}")
        try:
            legacy_db_path.rename(current_db_path)
            print("Database migration successful.")
        except Exception as e:
            print(f"Error migrating database: {e}")


async def create_light_user() -> bool:
    """Create initial light user interactively.

    Returns:
        True if user created, False if skipped or already exists
    """
    async with async_session_maker() as db:
        auth_service = AuthService(db)

        # Check if any user exists
        existing = await auth_service.get_user_by_username("light")
        if existing:
            print("Light user already exists, skipping creation.")
            return False

        print("\n--- Create Light User ---")
        print("(Press Ctrl+C to skip)\n")

        try:
            username = input("Username [light]: ").strip() or "light"
            email = input("Email: ").strip()
            display_name = input("Display name [Lightistrator]: ").strip() or "Lightistrator"

            while True:
                password = getpass.getpass("Password (min 8 chars): ")
                if len(password) < 8:
                    print("Password must be at least 8 characters.")
                    continue

                password_confirm = getpass.getpass("Confirm password: ")
                if password != password_confirm:
                    print("Passwords do not match. Try again.")
                    continue

                break

            # Hash the password with SHA-256 to match client-side obfuscation
            hashed_name = hashlib.sha256(password.encode()).hexdigest()

            user_data = UserCreate(
                username=username,
                email=email or f"{username}@localhost",
                password=hashed_name,
                display_name=display_name,
            )

            user = await auth_service.create_user(user_data)
            await db.commit()

            print(f"\nLight user '{user.username}' created successfully!")
            return True

        except KeyboardInterrupt:
            print("\nSkipped light user creation.")
            return False
        except ValueError as e:
            print(f"\nError: {e}")
            return False


async def create_default_admin() -> bool:
    """Create default admin user if no users exist.

    Creates user with credentials admin/admin.

    Returns:
        True if user created, False if skipped
    """
    async with async_session_maker() as db:
        auth_service = AuthService(db)

        # Check if any user exists
        # Since we don't have a count method handy on the service, checking for 'admin' specifically
        # However, to be safe for dev envs, let's just try to create 'admin'
        existing = await auth_service.get_user_by_username("admin")
        if existing:
            print("Admin user already exists, skipping creation.")
            return False

        print("Creating default admin user (admin/admin)...")

        # Hash "admin" with SHA-256
        hashed_password = hashlib.sha256(b"admin").hexdigest()

        user_data = UserCreate(
            username="admin",
            email="admin@example.com",
            password=hashed_password,
            display_name="Administrator",
        )

        try:
            user = await auth_service.create_user(user_data)
            await db.commit()
            print(f"Default admin user '{user.username}' created successfully!")
            return True
        except Exception as e:
            print(f"Failed to create admin user: {e}")
            return False


async def main() -> None:
    """Initialize database tables and optionally create light user."""

    # Check for legacy database migration
    migrate_legacy_db_name()

    print("Creating database tables...")
    await create_tables()
    print("Database tables created successfully!")

    # Check for --create-light flag
    if "--create-light" in sys.argv:
        await create_light_user()

    # Check for --create-admin flag
    if "--create-admin" in sys.argv:
        await create_default_admin()

    # Close engine
    await engine.dispose()

    print("\nDatabase initialization complete.")


if __name__ == "__main__":
    asyncio.run(main())
