"""Authentication service for user and session management.

Handles password hashing, session creation, and authentication logic.
"""

import secrets
import bcrypt
from datetime import datetime, timedelta
from hashlib import sha256
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.session import Session
from app.models.user import User
from app.schemas.auth import UserCreate

settings = get_settings()

def hash_password(password: str) -> str:
    """Hash a password using bcrypt.

    Args:
        password: Plain text password

    Returns:
        Hashed password string
    """
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(password.encode(), salt)
    return hashed.decode()


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against its hash.

    Args:
        plain_password: Plain text password to verify
        hashed_password: Stored password hash

    Returns:
        True if password matches, False otherwise
    """
    try:
        # Use bcrypt directly as it's more reliable on this system
        return bcrypt.checkpw(plain_password.encode(), hashed_password.encode())
    except Exception as e:
        print(f"VERIFY ERROR: {e}")
        return False


def generate_session_token() -> str:
    """Generate a secure random session token.

    Returns:
        64-character hexadecimal token
    """
    return secrets.token_hex(32)


def hash_token(token: str) -> str:
    """Hash a session token for storage.

    Args:
        token: Plain session token

    Returns:
        SHA256 hash of token
    """
    return sha256(token.encode()).hexdigest()


class AuthService:
    """Service for authentication operations."""

    def __init__(self, db: AsyncSession):
        """Initialize auth service.

        Args:
            db: Async database session
        """
        self.db = db

    async def get_user_by_username(self, username: str) -> User | None:
        """Get user by username.

        Args:
            username: Username to look up

        Returns:
            User if found, None otherwise
        """
        result = await self.db.execute(select(User).where(User.username == username))
        return result.scalar_one_or_none()

    async def get_first_user(self) -> User | None:
        """Get the first user from the database.

        Useful for single-user blog systems.

        Returns:
            The first User found, or None if no users exist.
        """
        result = await self.db.execute(select(User).order_by(User.id))
        return result.scalars().first()

    async def get_user_by_id(self, user_id: int) -> User | None:
        """Get user by ID.

        Args:
            user_id: User ID to look up

        Returns:
            User if found, None otherwise
        """
        result = await self.db.execute(select(User).where(User.id == user_id))
        return result.scalar_one_or_none()

    async def create_user(self, user_data: UserCreate) -> User:
        """Create a new user.

        Args:
            user_data: User creation data

        Returns:
            Created user

        Raises:
            ValueError: If username already exists
        """
        existing = await self.get_user_by_username(user_data.username)
        if existing:
            raise ValueError(f"Username '{user_data.username}' already exists")

        user = User(
            username=user_data.username,
            email=user_data.email,
            password_hash=hash_password(user_data.password),
            display_name=user_data.display_name,
        )

        self.db.add(user)
        await self.db.flush()
        await self.db.refresh(user)

        return user

    async def authenticate_user(self, username: str, password: str) -> User | None:
        """Authenticate user with username and password.

        Args:
            username: Username
            password: Plain text password

        Returns:
            User if authentication successful, None otherwise
        """
        user = await self.get_user_by_username(username)
        if not user:
            return None

        if not verify_password(password, user.password_hash):
            return None

        # Update last login
        await self.db.execute(
            update(User).where(User.id == user.id).values(last_login=datetime.utcnow())
        )

        return user

    async def create_session(
        self,
        user_id: int,
        ip_address: str,
        user_agent: str,
        remember_me: bool = False,
    ) -> tuple[Session, str]:
        """Create a new session for user.

        Args:
            user_id: User ID
            ip_address: Client IP address
            user_agent: Client user agent string
            remember_me: If True, use extended session expiry

        Returns:
            Tuple of (Session, plain_token)
        """
        # Generate token
        plain_token = generate_session_token()
        hashed_token = hash_token(plain_token)

        # Calculate expiry
        if remember_me:
            expiry_hours = settings.session_expiry_hours
        else:
            expiry_hours = settings.session_expiry_public_hours

        expires_at = datetime.utcnow() + timedelta(hours=expiry_hours)

        # Create session
        session = Session(
            user_id=user_id,
            token=hashed_token,
            ip_address=ip_address,
            user_agent=user_agent[:500],  # Truncate if too long
            expires_at=expires_at,
        )

        self.db.add(session)
        await self.db.flush()
        await self.db.refresh(session)

        return session, plain_token

    async def validate_session(self, token: str) -> Session | None:
        """Validate a session token.

        Args:
            token: Plain session token

        Returns:
            Session if valid and not expired, None otherwise
        """
        hashed_token = hash_token(token)

        result = await self.db.execute(
            select(Session).where(Session.token == hashed_token)
        )
        session = result.scalar_one_or_none()

        if not session:
            return None

        if session.is_expired:
            # Clean up expired session
            await self.db.execute(delete(Session).where(Session.id == session.id))
            return None

        # Update last activity
        await self.db.execute(
            update(Session)
            .where(Session.id == session.id)
            .values(last_activity=datetime.utcnow())
        )

        return session

    async def terminate_session(self, session_id: int, user_id: int) -> bool:
        """Terminate a specific session.

        Args:
            session_id: Session ID to terminate
            user_id: User ID (for authorization check)

        Returns:
            True if session was terminated, False if not found
        """
        result = await self.db.execute(
            delete(Session).where(Session.id == session_id, Session.user_id == user_id)
        )
        # CursorResult has rowcount but type hints don't reflect this
        return int(result.rowcount) > 0  # type: ignore[attr-defined]

    async def terminate_all_sessions(
        self, user_id: int, except_session_id: int | None = None
    ) -> int:
        """Terminate all sessions for a user.

        Args:
            user_id: User ID
            except_session_id: Optional session ID to keep

        Returns:
            Number of sessions terminated
        """
        query = delete(Session).where(Session.user_id == user_id)

        if except_session_id:
            query = query.where(Session.id != except_session_id)

        result = await self.db.execute(query)
        return int(result.rowcount)  # type: ignore[attr-defined]

    async def get_user_sessions(self, user_id: int) -> list[Session]:
        """Get all sessions for a user.

        Args:
            user_id: User ID

        Returns:
            List of sessions
        """
        result = await self.db.execute(
            select(Session)
            .where(Session.user_id == user_id)
            .order_by(Session.last_activity.desc())
        )
        return list(result.scalars().all())

    async def change_password(
        self, user_id: int, current_password: str, new_password: str
    ) -> bool:
        """Change user password.

        Args:
            user_id: User ID
            current_password: Current password for verification
            new_password: New password

        Returns:
            True if password changed, False if current password incorrect

        Raises:
            ValueError: If new password doesn't meet requirements
        """
        if len(new_password) < settings.password_min_length:
            raise ValueError(
                f"Password must be at least {settings.password_min_length} characters"
            )

        user = await self.get_user_by_id(user_id)
        if not user:
            return False

        if not verify_password(current_password, user.password_hash):
            return False

        new_hash = hash_password(new_password)
        await self.db.execute(
            update(User).where(User.id == user_id).values(password_hash=new_hash)
        )

        return True

    async def cleanup_expired_sessions(self) -> int:
        """Remove all expired sessions.

        Returns:
            Number of sessions removed
        """
        result = await self.db.execute(
            delete(Session).where(Session.expires_at < datetime.utcnow())
        )
        return int(result.rowcount)  # type: ignore[attr-defined]
