#!/usr/bin/env python3
"""Initialize the database.

Creates all tables and optionally creates an initial admin user.
"""

import asyncio
import getpass
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.database import async_session_maker, create_tables, engine
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService


async def create_admin_user() -> bool:
    """Create initial admin user interactively.

    Returns:
        True if user created, False if skipped or already exists
    """
    async with async_session_maker() as db:
        auth_service = AuthService(db)

        # Check if any user exists
        existing = await auth_service.get_user_by_username("admin")
        if existing:
            print("Admin user already exists, skipping creation.")
            return False

        print("\n--- Create Admin User ---")
        print("(Press Ctrl+C to skip)\n")

        try:
            username = input("Username [admin]: ").strip() or "admin"
            email = input("Email: ").strip()
            display_name = input("Display name [Administrator]: ").strip() or "Administrator"

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

            user_data = UserCreate(
                username=username,
                email=email or f"{username}@localhost",
                password=password,
                display_name=display_name,
            )

            user = await auth_service.create_user(user_data)
            await db.commit()

            print(f"\nAdmin user '{user.username}' created successfully!")
            return True

        except KeyboardInterrupt:
            print("\nSkipped admin user creation.")
            return False
        except ValueError as e:
            print(f"\nError: {e}")
            return False


async def main() -> None:
    """Initialize database tables and optionally create admin user."""
    print("Creating database tables...")
    await create_tables()
    print("Database tables created successfully!")

    # Check for --create-admin flag
    if "--create-admin" in sys.argv:
        await create_admin_user()

    # Close engine
    await engine.dispose()

    print("\nDatabase initialization complete.")


if __name__ == "__main__":
    asyncio.run(main())
