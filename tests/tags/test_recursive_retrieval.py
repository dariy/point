
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.post import Post, PostFormatter, PostStatus
from app.schemas.tag import TagCreate
from app.services.tag_service import TagService


@pytest.fixture
def tag_service(db: AsyncSession):
    return TagService(db)

@pytest.mark.asyncio
class TestRecursiveTagRetrieval:
    async def test_get_descendant_tag_ids(self, tag_service: TagService, db: AsyncSession):
        """Test recursive descendant ID retrieval."""
        # A -> B -> C
        a = await tag_service.create_tag(TagCreate(name="A"))
        b = await tag_service.create_tag(TagCreate(name="B", parent_ids=[a.id]))
        c = await tag_service.create_tag(TagCreate(name="C", parent_ids=[b.id]))

        # Test A
        ids_a = await tag_service.get_descendant_tag_ids(a.id)
        assert ids_a == {a.id, b.id, c.id}

        # Test B
        ids_b = await tag_service.get_descendant_tag_ids(b.id)
        assert ids_b == {b.id, c.id}

    async def test_circular_reference_avoidance(self, tag_service: TagService, db: AsyncSession):
        """Test that circular references don't cause infinite loops."""
        # A -> B -> A
        a = await tag_service.create_tag(TagCreate(name="A"))
        b = await tag_service.create_tag(TagCreate(name="B", parent_ids=[a.id]))

        # Manually create circular reference (since TagService might not allow it easily or we haven't checked)
        a.parents.append(b)
        await db.commit()

        ids_a = await tag_service.get_descendant_tag_ids(a.id)
        assert ids_a == {a.id, b.id}

    async def test_get_posts_by_tag_recursive(self, tag_service: TagService, db: AsyncSession, test_user):
        """Test that get_posts_by_tag returns posts from sub-tags."""
        user_id = test_user["user"].id
        # A -> B
        a = await tag_service.create_tag(TagCreate(name="Parent"))
        b = await tag_service.create_tag(TagCreate(name="Child", parent_ids=[a.id]))

        # Post 1 tagged with A
        p1 = Post(title="P1", slug="p1", content="C", status=PostStatus.PUBLISHED, author_id=user_id, formatter=PostFormatter.MARKDOWN)
        p1.tags.append(a)

        # Post 2 tagged with B
        p2 = Post(title="P2", slug="p2", content="C", status=PostStatus.PUBLISHED, author_id=user_id, formatter=PostFormatter.MARKDOWN)
        p2.tags.append(b)

        db.add_all([p1, p2])
        await db.commit()

        # Get posts for A (should return P1 and P2)
        posts_a, total_a = await tag_service.get_posts_by_tag(a.id, recursive=True)
        assert total_a == 2
        post_ids = {p.id for p in posts_a}
        assert p1.id in post_ids
        assert p2.id in post_ids

        # Get posts for B (should return only P2)
        posts_b, total_b = await tag_service.get_posts_by_tag(b.id, recursive=True)
        assert total_b == 1
        assert posts_b[0].id == p2.id

    async def test_update_post_count_recursive(self, tag_service: TagService, db: AsyncSession, test_user):
        """Test that post counts reflect sub-tag posts."""
        user_id = test_user["user"].id
        # A -> B
        a = await tag_service.create_tag(TagCreate(name="Parent"))
        b = await tag_service.create_tag(TagCreate(name="Child", parent_ids=[a.id]))

        # Post 1 tagged with B
        p1 = Post(title="P1", slug="p1", content="C", status=PostStatus.PUBLISHED, author_id=user_id, formatter=PostFormatter.MARKDOWN)
        p1.tags.append(b)
        db.add(p1)
        await db.commit()

        # Update counts
        await tag_service.update_all_post_counts()

        await db.refresh(a)
        await db.refresh(b)

        assert b.post_count == 1
        assert a.post_count == 1

    async def test_update_post_counts_on_tagging(self, tag_service: TagService, db: AsyncSession, test_user):
        """Test that tagging a post updates ancestor counts."""
        user_id = test_user["user"].id
        # A -> B
        a = await tag_service.create_tag(TagCreate(name="Parent"))
        b = await tag_service.create_tag(TagCreate(name="Child", parent_ids=[a.id]))

        post = Post(title="P", slug="p", content="C", status=PostStatus.PUBLISHED, author_id=user_id, formatter=PostFormatter.MARKDOWN)
        db.add(post)
        await db.commit()
        await db.refresh(post, ["tags"])

        # Add tag B to post
        await tag_service.add_tags_to_post(post, ["Child"])

        await db.refresh(a)
        await db.refresh(b)

        assert b.post_count == 1
        assert a.post_count == 1
