"""Media service for file upload and management.

Handles file upload, processing, storage, and cleanup operations.
"""

import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import aiofiles
import aiofiles.os
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.media import FileType, Media
from app.utils.formatters import extract_all_media
from app.utils.image_processor import (
    ImageProcessor,
    calculate_checksum,
    ensure_directory,
    is_image_mime,
)
from app.utils.validators import (
    get_file_type,
    sanitize_filename,
    validate_file_extension,
    validate_file_size,
    validate_mime_type,
    validate_storage_quota,
)


class MediaService:
    """Service for managing media files."""

    def __init__(self, db: AsyncSession):
        """Initialize media service.

        Args:
            db: Async database session
        """
        self.db = db
        self.settings = get_settings()
        self.storage_path = Path(self.settings.storage_path)
        self.originals_path = self.storage_path / "media" / "originals"
        self.thumbnails_path = self.storage_path / "media" / "thumbnails"
        self.image_processor = ImageProcessor()

    def _generate_unique_filename(self, original_filename: str) -> str:
        """Generate a unique filename preserving extension.

        Args:
            original_filename: Original uploaded filename

        Returns:
            Unique filename with UUID prefix
        """
        safe_name = sanitize_filename(original_filename)
        ext = Path(safe_name).suffix.lower()
        name = Path(safe_name).stem
        unique_id = uuid.uuid4().hex[:8]
        return f"{name}_{unique_id}{ext}"

    def _get_storage_paths(
        self, filename: str, year: int, month: int
    ) -> tuple[Path, Path, str, str]:
        """Get storage paths for a file.

        Args:
            filename: Filename to store
            year: Year for directory structure
            month: Month for directory structure

        Returns:
            Tuple of (original_full_path, thumbnail_full_path,
                      original_relative_path, thumbnail_relative_path)
        """
        date_path = f"{year}/{month:02d}"
        original_dir = self.originals_path / date_path
        thumbnail_dir = self.thumbnails_path / date_path

        ensure_directory(original_dir)
        ensure_directory(thumbnail_dir)

        original_full = original_dir / filename
        thumbnail_full = thumbnail_dir / filename

        # Store relative paths in DB (relative to storage_path/media)
        original_rel = f"originals/{date_path}/{filename}"
        thumbnail_rel = f"thumbnails/{date_path}/{filename}"

        return original_full, thumbnail_full, original_rel, thumbnail_rel

    async def _check_duplicate(self, checksum: str) -> Media | None:
        """Check if a file with the same checksum exists.

        Args:
            checksum: SHA256 checksum

        Returns:
            Existing media if duplicate, None otherwise
        """
        result = await self.db.execute(select(Media).where(Media.checksum == checksum))
        return result.scalars().first()

    async def calculate_storage_usage(self) -> int:
        """Calculate total storage usage in bytes.

        Returns:
            Total storage used in bytes
        """
        result = await self.db.execute(select(func.sum(Media.file_size)))
        total = result.scalar() or 0
        return total

    async def upload_file(
        self,
        content: bytes,
        filename: str,
        mime_type: str,
        alt_text: str | None = None,
        caption: str | None = None,
        post_id: int | None = None,
        created_at: datetime | None = None,
    ) -> Media:
        """Upload and process a file.

        Args:
            content: File content bytes
            filename: Original filename
            mime_type: MIME type
            alt_text: Alt text for accessibility
            caption: Optional caption
            post_id: Optional post to link to
            created_at: Optional creation timestamp (defaults to now)

        Returns:
            Created media record

        Raises:
            FileValidationError: If validation fails
        """
        # Validate
        validate_file_extension(filename)
        validate_mime_type(mime_type, filename)
        validate_file_size(len(content))

        # Check storage quota
        current_usage = await self.calculate_storage_usage()
        validate_storage_quota(current_usage, len(content))

        # Calculate checksum
        checksum = calculate_checksum(content)

        # Check for duplicate
        existing = await self._check_duplicate(checksum)
        if existing:
            return existing

        # Determine file type
        file_type = get_file_type(mime_type)

        # Generate unique filename and paths
        unique_filename = self._generate_unique_filename(filename)
        now = created_at or datetime.now(UTC)
        original_path, thumbnail_path, original_rel, thumbnail_rel = (
            self._get_storage_paths(unique_filename, now.year, now.month)
        )

        # Process image if applicable
        width, height = None, None
        thumbnail_rel_final = None

        if is_image_mime(mime_type) and not mime_type.endswith("svg+xml"):
            # Process and potentially resize image
            processed_content, width, height, _ = self.image_processor.process_image(
                content
            )

            # Save processed original
            async with aiofiles.open(original_path, "wb") as f:
                await f.write(processed_content)

            # Generate thumbnail
            thumbnail_content, _, _ = self.image_processor.generate_thumbnail(content)
            thumbnail_jpg_name = Path(unique_filename).stem + ".jpg"
            thumbnail_path = thumbnail_path.parent / thumbnail_jpg_name
            thumbnail_rel_final = (
                f"thumbnails/{now.year}/{now.month:02d}/{thumbnail_jpg_name}"
            )

            async with aiofiles.open(thumbnail_path, "wb") as f:
                await f.write(thumbnail_content)
        else:
            # Save non-image files directly
            async with aiofiles.open(original_path, "wb") as f:
                await f.write(content)

        # Create database record
        media = Media(
            filename=filename,
            original_path=original_rel,
            thumbnail_path=thumbnail_rel_final,
            file_type=FileType(file_type),
            mime_type=mime_type,
            file_size=len(content),
            width=width,
            height=height,
            post_id=post_id,
            checksum=checksum,
            alt_text=alt_text,
            caption=caption,
            uploaded_at=now,
        )

        self.db.add(media)
        await self.db.flush()
        await self.db.refresh(media)

        return media

    async def get_media_by_id(self, media_id: int) -> Media | None:
        """Get media by ID.

        Args:
            media_id: Media ID

        Returns:
            Media if found, None otherwise
        """
        result = await self.db.execute(select(Media).where(Media.id == media_id))
        return result.scalars().first()

    async def get_media_by_checksum(self, checksum: str) -> Media | None:
        """Get media by checksum.

        Args:
            checksum: SHA256 checksum

        Returns:
            Media if found, None otherwise
        """
        return await self._check_duplicate(checksum)

    async def list_media(
        self,
        page: int = 1,
        per_page: int = 20,
        file_type: str | None = None,
        orphaned_only: bool = False,
    ) -> tuple[list[Media], int]:
        """List media files with pagination.

        Args:
            page: Page number (1-indexed)
            per_page: Items per page
            file_type: Filter by file type
            orphaned_only: Only return orphaned files

        Returns:
            Tuple of (media_list, total_count)
        """
        query = select(Media)

        if file_type:
            query = query.where(Media.file_type == FileType(file_type))

        if orphaned_only:
            orphaned, _, _ = await self.get_orphaned_media()
            orphaned_ids = [m.id for m in orphaned]
            if not orphaned_ids:
                return [], 0
            query = query.where(Media.id.in_(orphaned_ids))

        # Get total count
        count_query = select(func.count()).select_from(query.subquery())
        total_result = await self.db.execute(count_query)
        total = total_result.scalar() or 0

        # Get paginated results
        offset = (page - 1) * per_page
        query = query.order_by(Media.uploaded_at.desc()).offset(offset).limit(per_page)

        result = await self.db.execute(query)
        media_list = list(result.scalars().all())

        return media_list, total

    async def update_media(
        self,
        media_id: int,
        alt_text: str | None = None,
        caption: str | None = None,
        post_id: int | None = None,
    ) -> Media | None:
        """Update media metadata.

        Args:
            media_id: Media ID
            alt_text: New alt text
            caption: New caption
            post_id: New post ID

        Returns:
            Updated media if found, None otherwise
        """
        media = await self.get_media_by_id(media_id)
        if not media:
            return None

        if alt_text is not None:
            media.alt_text = alt_text
        if caption is not None:
            media.caption = caption
        if post_id is not None:
            media.post_id = post_id

        await self.db.flush()
        await self.db.refresh(media)

        return media

    async def rename_media(self, media_id: int, new_filename: str) -> Media | None:
        """Rename a media file and update all references in posts.

        Args:
            media_id: Media ID to rename
            new_filename: New filename with extension

        Returns:
            Updated media if successful, None otherwise
        """
        media = await self.get_media_by_id(media_id)
        if not media:
            return None

        # Sanitize and prepare new filename
        new_filename = sanitize_filename(new_filename)
        old_ext = Path(media.filename).suffix.lower()
        new_ext = Path(new_filename).suffix.lower()

        # If extension missing, add old one
        if not new_ext and old_ext:
            new_filename += old_ext

        if new_filename == media.filename:
            return media

        # Determine path components
        parts = media.original_path.split("/")
        if len(parts) < 4:
            return None
        date_path = f"{parts[1]}/{parts[2]}"

        # New relative paths
        new_original_rel = f"originals/{date_path}/{new_filename}"
        new_thumbnail_rel = None
        if media.thumbnail_path:
            thumb_ext = Path(media.thumbnail_path).suffix
            new_thumbnail_rel = f"thumbnails/{date_path}/{Path(new_filename).stem}{thumb_ext}"

        # Paths on disk
        new_original_full = self.storage_path / "media" / new_original_rel
        if new_original_full.exists():
             raise ValueError(f"File already exists: {new_filename}")

        # Record old URLs for reference updates
        old_url = self.get_media_url(media)
        old_media_path = f"/media/{media.original_path}"
        
        # Perform physical rename
        old_original_full = self.storage_path / "media" / media.original_path
        if old_original_full.exists():
             await aiofiles.os.rename(old_original_full, new_original_full)
        
        if media.thumbnail_path and new_thumbnail_rel:
            old_thumbnail_full = self.storage_path / "media" / media.thumbnail_path
            new_thumbnail_full = self.storage_path / "media" / new_thumbnail_rel
            if old_thumbnail_full.exists():
                await aiofiles.os.rename(old_thumbnail_full, new_thumbnail_full)

        # Update media record
        media.filename = new_filename
        media.original_path = new_original_rel
        media.thumbnail_path = new_thumbnail_rel
        
        # Get new URLs
        new_url = self.get_media_url(media)
        new_media_path = f"/media/{new_original_rel}"

        # Update references in posts
        await self._update_references(old_url, new_url, old_media_path, new_media_path)

        await self.db.flush()
        await self.db.refresh(media)

        return media

    async def _update_references(self, old_url: str, new_url: str, old_path: str, new_path: str):
        """Update all references to a media file in post content."""
        from app.models.post import Post
        from sqlalchemy import update

        # Update content and excerpt in posts
        # Note: We replace both the simplified URL and the full /media/ path
        for o, n in [(old_url, new_url), (old_path, new_path)]:
            if o == n: continue
            
            # Content replacement
            await self.db.execute(
                update(Post)
                .where(Post.content.contains(o))
                .values(content=func.replace(Post.content, o, n))
            )
            # Excerpt replacement
            await self.db.execute(
                update(Post)
                .where(Post.excerpt.contains(o))
                .values(excerpt=func.replace(Post.excerpt, o, n))
            )
            # Thumbnail path replacement
            await self.db.execute(
                update(Post)
                .where(Post.thumbnail_path == o)
                .values(thumbnail_path=n)
            )

    async def delete_media(self, media_id: int) -> tuple[bool, int]:
        """Delete a media file and its database record.

        Args:
            media_id: Media ID to delete

        Returns:
            Tuple of (success, freed_bytes)
        """
        media = await self.get_media_by_id(media_id)
        if not media:
            return False, 0

        freed_bytes = media.file_size

        # Delete physical files
        original_full = self.storage_path / "media" / media.original_path
        if original_full.exists():
            await aiofiles.os.remove(original_full)

        if media.thumbnail_path:
            thumbnail_full = self.storage_path / "media" / media.thumbnail_path
            if thumbnail_full.exists():
                await aiofiles.os.remove(thumbnail_full)

        # Delete database record
        await self.db.delete(media)
        await self.db.flush()

        return True, freed_bytes

    async def get_orphaned_media(self, grace_period_hours: int = 24) -> tuple[list[Media], int, int]:
        """Get all orphaned media (not linked to any post and not used in content).

        Args:
            grace_period_hours: Hours to wait before considering a file orphaned.

        Returns:
            Tuple of (orphaned_list, count, total_size)
        """
        from app.models.post import Post
        from app.models.settings import BlogSettings
        from app.models.user import User

        # 1. Get candidates: no post_id and older than grace period
        now = datetime.now(UTC)
        grace_threshold = now - timedelta(hours=grace_period_hours)

        result = await self.db.execute(
            select(Media).where(
                Media.post_id.is_(None),
                Media.uploaded_at < grace_threshold
            )
        )
        candidates = list(result.scalars().all())

        if not candidates:
            return [], 0, 0

        # 2. Collect all potential media references from the database
        used_paths = set()

        # Helper to extract and normalize paths
        def collect_paths(text: str | None) -> None:
            if not text:
                return
            found = extract_all_media(text)
            for item in found:
                url = item["url"]
                # Normalize URL to relative path used in DB
                if "/media/" in url:
                    # Extract everything after /media/
                    path = url.split("/media/", 1)[1]
                    # Remove query parameters
                    path = path.split("?", 1)[0]
                    used_paths.add(path)
                else:
                    # Could be direct relative path or external (ignored)
                    used_paths.add(url)

        # Scan Posts
        post_result = await self.db.execute(
            select(Post.content, Post.excerpt, Post.thumbnail_path)
        )
        for post_row in post_result.all():
            collect_paths(post_row.content)
            collect_paths(post_row.excerpt)
            if post_row.thumbnail_path:
                # thumbnail_path in Post might be a URL or relative path
                collect_paths(post_row.thumbnail_path)

        # Scan Users (avatars)
        user_result = await self.db.execute(select(User.avatar_path))
        for user_row in user_result.all():
            if user_row.avatar_path:
                collect_paths(user_row.avatar_path)

        # Scan Settings
        settings_result = await self.db.execute(select(BlogSettings.value))
        for settings_row in settings_result.all():
            collect_paths(settings_row.value)

        # 3. Filter candidates
        orphaned = []
        for media in candidates:
            # Check original path and thumbnail path
            if media.original_path not in used_paths and (
                not media.thumbnail_path or media.thumbnail_path not in used_paths
            ):
                orphaned.append(media)

        total_size = sum(m.file_size for m in orphaned)

        return orphaned, len(orphaned), total_size

    async def cleanup_orphaned(self) -> tuple[int, int]:
        """Delete all orphaned media files.

        Returns:
            Tuple of (deleted_count, freed_bytes)
        """
        orphaned, _, _ = await self.get_orphaned_media()
        deleted_count = 0
        freed_bytes = 0

        for media in orphaned:
            success, freed = await self.delete_media(media.id)
            if success:
                deleted_count += 1
                freed_bytes += freed

        return deleted_count, freed_bytes

    async def get_storage_stats(self) -> dict[str, Any]:
        """Get storage statistics.

        Returns:
            Dictionary with storage statistics
        """
        # Total files and size
        total_result = await self.db.execute(
            select(func.count(), func.sum(Media.file_size))
        )
        total_row = total_result.one()
        total_files = total_row[0] or 0
        total_size = total_row[1] or 0

        # Orphaned files (using refined logic)
        _, orphaned_files, orphaned_size = await self.get_orphaned_media()

        # By type breakdown
        by_type = {}
        for ft in FileType:
            type_result = await self.db.execute(
                select(func.count(), func.sum(Media.file_size)).where(
                    Media.file_type == ft
                )
            )
            type_row = type_result.one()
            by_type[ft.value] = {
                "count": type_row[0] or 0,
                "size_bytes": type_row[1] or 0,
            }

        quota = self.settings.storage_quota_bytes

        return {
            "total_files": total_files,
            "total_size_bytes": total_size,
            "total_size_mb": round(total_size / (1024 * 1024), 2),
            "quota_bytes": quota,
            "quota_mb": round(quota / (1024 * 1024), 2),
            "usage_percent": round((total_size / quota) * 100, 2) if quota else 0,
            "orphaned_files": orphaned_files,
            "orphaned_size_bytes": orphaned_size,
            "by_type": by_type,
        }

    def get_media_url(self, media: Media) -> str:
        """Get public URL for a media file.

        Args:
            media: Media record

        Returns:
            Public URL path
        """
        # Return simplified path format: /YYYY/MM/filename
        # original_path is "originals/YYYY/MM/filename"
        parts = media.original_path.split("/")
        if len(parts) >= 4:
            return f"/{parts[1]}/{parts[2]}/{parts[3]}"
        return f"/media/{media.original_path}"

    def get_thumbnail_url(self, media: Media) -> str | None:
        """Get public URL for thumbnail.

        Args:
            media: Media record

        Returns:
            Thumbnail URL path or None
        """
        if media.thumbnail_path:
            return f"/media/{media.thumbnail_path}"
        return None
