#!/usr/bin/env python3
"""Initialize the database.

Creates all tables and optionally creates an initial light user.
"""

import asyncio
import getpass
import sys
import hashlib
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.database import async_session_maker, create_tables, engine
from app.schemas.auth import UserCreate
from app.services.auth_service import AuthService


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


async def main() -> None:
    """Initialize database tables and optionally create light user."""
    print("Creating database tables...")
    await create_tables()
    print("Database tables created successfully!")

    # Check for --create-light flag
    if "--create-light" in sys.argv:
        await create_light_user()

    # Close engine
    await engine.dispose()

    print("\nDatabase initialization complete.")


if __name__ == "__main__":
    asyncio.run(main())
