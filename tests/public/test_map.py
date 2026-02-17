
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.tag import Tag


@pytest.mark.asyncio
async def test_map_page_status(client: AsyncClient):
    """Test that map page returns 200 OK."""
    response = await client.get("/map")
    assert response.status_code == 200
    assert "Global Map" in response.text

@pytest.mark.asyncio

async def test_map_data_ajax(client: AsyncClient, db: AsyncSession):

    """Test that map page returns JSON data for AJAX requests."""

    # Create a tag with locations and a published post

    from app.models.tag_location import TagLocation

    tag = Tag(name="MapTag", slug="map-tag", post_count=1)

    db.add(tag)

    await db.flush()

    

    loc1 = TagLocation(tag_id=tag.id, latitude=10.0, longitude=20.0)

    loc2 = TagLocation(tag_id=tag.id, latitude=15.0, longitude=25.0)

    db.add_all([loc1, loc2])

    await db.flush()

    

    response = await client.get("/map", headers={"X-Requested-With": "XMLHttpRequest"})

    assert response.status_code == 200

    data = response.json()

    assert "tags" in data

    

    # Check if our locations are in the list

    tag_names = [t["name"] for t in data["tags"]]

    assert tag_names.count("MapTag") == 2

    

    # Check tag data structure

    map_tags = [t for t in data["tags"] if t["name"] == "MapTag"]

    assert any(t["lat"] == 10.0 and t["lng"] == 20.0 for t in map_tags)

    assert any(t["lat"] == 15.0 and t["lng"] == 25.0 for t in map_tags)



@pytest.mark.asyncio

async def test_map_page_filters_hidden_tags(client: AsyncClient, db: AsyncSession):

    """Test that hidden tags are not shown on map for public users."""

    from app.models.tag_location import TagLocation

    # Create a hidden tag with coordinates

    tag = Tag(name="HiddenMapTag", slug="hidden-map-tag", post_count=1, is_hidden=True)

    db.add(tag)

    await db.flush()

    

    loc = TagLocation(tag_id=tag.id, latitude=30.0, longitude=40.0)

    db.add(loc)

    await db.flush()


