
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.tag import Tag


@pytest.mark.asyncio

async def test_map_page_status(client: AsyncClient) -> None:
    """Test that map page returns 200 OK."""
    response = await client.get("/map")
    assert response.status_code == 200
    assert "map-container" in response.text

@pytest.mark.asyncio
async def test_map_data_ajax(client: AsyncClient, db: AsyncSession) -> None:
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
async def test_map_page_filters_hidden_tags(client: AsyncClient, db: AsyncSession) -> None:
    """Test that hidden tags are not shown on map for public users."""
    from app.models.tag_location import TagLocation
    # Create a hidden tag with coordinates
    tag = Tag(name="HiddenMapTag", slug="hidden-map-tag", post_count=1, is_hidden=True)
    db.add(tag)
    await db.flush()

    loc = TagLocation(tag_id=tag.id, latitude=30.0, longitude=40.0)
    db.add(loc)
    await db.flush()

    response = await client.get("/map", headers={"X-Requested-With": "XMLHttpRequest"})
    data = response.json()
    tag_names = [t["name"] for t in data["tags"]]
    assert "HiddenMapTag" not in tag_names

@pytest.mark.asyncio
async def test_update_map_coords_endpoint(client: AsyncClient, db: AsyncSession, auth_cookies: dict[str, str]) -> None:
    """Test the system endpoint for updating map coordinates."""

    cities_tag = Tag(name="cities", slug="cities")
    berlin_tag = Tag(name="Berlin", slug="berlin")
    db.add_all([cities_tag, berlin_tag])
    await db.flush()

    # Establish hierarchy
    from sqlalchemy import insert

    from app.models.tag import tag_relationships
    await db.execute(insert(tag_relationships).values(parent_id=cities_tag.id, child_id=berlin_tag.id))
    await db.commit()

    # Without auth - use a fresh client to be absolutely sure no state is shared
    from httpx import ASGITransport, AsyncClient

    from app.main import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as anon_client:
        response = await anon_client.post("/api/system/map/update-coords")
        assert response.status_code == 401

    # With auth - mock to avoid real API calls
    from unittest.mock import patch
    with patch("app.services.tag_service.TagService.update_missing_coords") as mock_update:
        mock_update.return_value = {"status": "success", "updated_count": 1, "message": "Updated coordinates for 1 tags."}

        response = await client.post("/api/system/map/update-coords", cookies=auth_cookies)
        assert response.status_code == 200
        data = response.json()
        assert data["updated_count"] == 1
        assert mock_update.called

@pytest.mark.asyncio
async def test_map_categorization(client: AsyncClient, db: AsyncSession):
    """Test that tags are correctly categorized as city or country."""
    from sqlalchemy import insert

    from app.models.tag import tag_relationships
    from app.models.tag_location import TagLocation

    # Setup hierarchy
    countries_tag = Tag(name="countries", slug="countries")
    germany_tag = Tag(name="Germany", slug="germany", post_count=1)
    cities_tag = Tag(name="cities", slug="cities")
    berlin_tag = Tag(name="Berlin", slug="berlin", post_count=1)

    db.add_all([countries_tag, germany_tag, cities_tag, berlin_tag])
    await db.flush()

    await db.execute(insert(tag_relationships).values([
        {"parent_id": countries_tag.id, "child_id": germany_tag.id},
        {"parent_id": cities_tag.id, "child_id": berlin_tag.id}
    ]))

    # Add locations
    db.add_all([
        TagLocation(tag_id=germany_tag.id, latitude=51.0, longitude=10.0),
        TagLocation(tag_id=berlin_tag.id, latitude=52.5, longitude=13.4)
    ])
    await db.commit()

    response = await client.get("/map", headers={"X-Requested-With": "XMLHttpRequest"})
    data = response.json()

    germany = next(t for t in data["tags"] if t["name"] == "Germany")
    berlin = next(t for t in data["tags"] if t["name"] == "Berlin")

    assert germany["type"] == "country"
    assert berlin["type"] == "city"
