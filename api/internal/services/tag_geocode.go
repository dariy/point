package services

// Geocoding: turning a tag name into coordinates and coordinates into a place
// tag, via Nominatim. Split out of tag_service.go because it is the only part
// of the tag system that talks to a third-party HTTP API, with its own rate
// etiquette and failure modes, and it shares nothing with the hierarchy logic
// beyond the TagService receiver.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"point-api/internal/models"
	"point-api/internal/utils"
)

// GeocodeTag looks up coordinates for a tag by name via Nominatim and stores them.
func (s *TagService) GeocodeTag(ctx context.Context, id int64) (float64, float64, error) {
	tag, err := s.repo.GetTag(ctx, id)
	if err != nil {
		return 0, 0, err
	}
	lat, lon, err := s.geocodeName(ctx, tag.Name)
	if err != nil {
		return 0, 0, err
	}
	if err := s.repo.UpsertTagLocation(ctx, id, lat, lon); err != nil {
		return 0, 0, err
	}
	s.Invalidate()
	return lat, lon, nil
}

// nominatimGet sends a GET to a Nominatim endpoint and returns the body.
func nominatimGet(ctx context.Context, endpoint string, params url.Values) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Point/1.0.0")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = resp.Body.Close()
	}()
	return io.ReadAll(resp.Body)
}

// geocodeName resolves a place name to the coordinates Nominatim gives for
// the place itself (its centre), via the forward search API.
func (s *TagService) geocodeName(ctx context.Context, name string) (float64, float64, error) {
	body, err := nominatimGet(ctx, s.nominatimBaseURL, url.Values{
		"q":      {name},
		"format": {"json"},
		"limit":  {"1"},
	})
	if err != nil {
		return 0, 0, err
	}

	var results []struct {
		Lat string `json:"lat"`
		Lon string `json:"lon"`
	}
	if err := json.Unmarshal(body, &results); err != nil || len(results) == 0 {
		return 0, 0, wrapKind(ErrUpstream, fmt.Errorf("no geocoding results for %q", name))
	}

	lat, latErr := strconv.ParseFloat(results[0].Lat, 64)
	lon, lonErr := strconv.ParseFloat(results[0].Lon, 64)
	if latErr != nil || lonErr != nil {
		return 0, 0, wrapKind(ErrUpstream, fmt.Errorf("bad coordinates for %q", name))
	}
	return lat, lon, nil
}

// reversePlace is what a reverse lookup yields: the city (or the most specific
// populated place below the country) and the country. CityLat/CityLon are the
// coordinates of the place itself, never the coordinates that were looked up.
type reversePlace struct {
	City, Country    string
	CityLat, CityLon float64
	HasCityCoords    bool
}

// reverseGeocode resolves the place at the given coordinates via the Nominatim
// reverse API. City is the most specific place name available (city, then
// town/village/municipality, then county, state); Country is kept apart. An
// error is returned when the lookup fails or neither name is present.
func (s *TagService) reverseGeocode(ctx context.Context, lat, lon float64) (reversePlace, error) {
	body, err := nominatimGet(ctx, s.nominatimReverseURL, url.Values{
		"lat":            {strconv.FormatFloat(lat, 'f', -1, 64)},
		"lon":            {strconv.FormatFloat(lon, 'f', -1, 64)},
		"format":         {"jsonv2"},
		"zoom":           {"10"}, // city level
		"addressdetails": {"1"},
	})
	if err != nil {
		return reversePlace{}, err
	}

	var result struct {
		Name    string `json:"name"`
		Lat     string `json:"lat"`
		Lon     string `json:"lon"`
		Address struct {
			City         string `json:"city"`
			Town         string `json:"town"`
			Village      string `json:"village"`
			Municipality string `json:"municipality"`
			Hamlet       string `json:"hamlet"`
			Suburb       string `json:"suburb"`
			County       string `json:"county"`
			State        string `json:"state"`
			Country      string `json:"country"`
		} `json:"address"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return reversePlace{}, wrapKind(ErrUpstream, fmt.Errorf("parse reverse geocode response: %w", err))
	}

	a := result.Address
	p := reversePlace{Country: strings.TrimSpace(a.Country)}
	for _, candidate := range []string{
		a.City, a.Town, a.Village, a.Municipality, a.Hamlet, a.Suburb,
		a.County, a.State, result.Name,
	} {
		if name := strings.TrimSpace(candidate); name != "" && name != p.Country {
			p.City = name
			break
		}
	}
	// At zoom 10 the result object is the matched place, so its lat/lon is
	// the place's own point, not the photo's.
	cityLat, latErr := strconv.ParseFloat(result.Lat, 64)
	cityLon, lonErr := strconv.ParseFloat(result.Lon, 64)
	if latErr == nil && lonErr == nil && (cityLat != lat || cityLon != lon) {
		p.CityLat, p.CityLon, p.HasCityCoords = cityLat, cityLon, true
	}
	if p.City == "" && p.Country == "" {
		return reversePlace{}, wrapKind(ErrUpstream, fmt.Errorf("no place name for coordinates %f,%f", lat, lon))
	}
	return p, nil
}

// findOrCreatePlaceTag returns the tag named name, creating it when missing.
// Coordinates, when given, are the place's own centre; they are set on a new
// tag and backfilled on an existing tag that has none.
func (s *TagService) findOrCreatePlaceTag(ctx context.Context, name string, lat, lon float64, hasCoords bool) (models.Tag, bool, error) {
	slug := utils.Slugify(name)
	tag, err := s.repo.GetTagBySlug(ctx, slug)
	if err != nil {
		params := models.CreateTagParams{Name: name, Slug: slug}
		if hasCoords {
			params.Latitude = sql.NullFloat64{Float64: lat, Valid: true}
			params.Longitude = sql.NullFloat64{Float64: lon, Valid: true}
		}
		tag, err = s.repo.CreateTag(ctx, params)
		if err != nil {
			return models.Tag{}, false, fmt.Errorf("create location tag %q: %w", name, err)
		}
		return tag, true, nil
	}
	if hasCoords && (!tag.Latitude.Valid || !tag.Longitude.Valid) {
		if err := s.repo.UpsertTagLocation(ctx, tag.ID, lat, lon); err != nil {
			return models.Tag{}, false, fmt.Errorf("set location for tag %q: %w", name, err)
		}
		tag.Latitude = sql.NullFloat64{Float64: lat, Valid: true}
		tag.Longitude = sql.NullFloat64{Float64: lon, Valid: true}
	}
	return tag, false, nil
}

// linkUnderBase makes child a child of the first existing base tag among
// names (e.g. "countries"). It is a no-op when no such base tag exists.
func (s *TagService) linkUnderBase(ctx context.Context, child models.Tag, names ...string) {
	bases, err := s.repo.FindTagsByNames(ctx, names)
	if err != nil || len(bases) == 0 {
		return
	}
	if err := s.AddTagRelationship(ctx, bases[0].ID, child.ID); err != nil {
		slog.Warn("link location tag under base tag failed", "tag", child.Name, "base", bases[0].Name, "error", err)
	}
}

// TagPostWithLocation reverse-geocodes the given coordinates to a city and a
// country, finds or creates a tag for each, and attaches the city tag (or the
// country tag, when there is no city) to the post. A new city tag becomes a
// child of its country tag.
//
// The given coordinates are the photo's position and are never stored: each
// tag carries the coordinates of the place itself. It is best-effort: callers
// may ignore the returned error.
func (s *TagService) TagPostWithLocation(ctx context.Context, postID int64, lat, lon float64) (models.Tag, error) {
	place, err := s.reverseGeocode(ctx, lat, lon)
	if err != nil {
		return models.Tag{}, err
	}

	var country models.Tag
	hasCountry := false
	if place.Country != "" {
		// Look up the country's centre only when the tag would need it.
		var cLat, cLon float64
		hasCoords := false
		if existing, gerr := s.repo.GetTagBySlug(ctx, utils.Slugify(place.Country)); gerr != nil || !existing.Latitude.Valid {
			if cLat, cLon, gerr = s.geocodeName(ctx, place.Country); gerr != nil {
				slog.Warn("geocoding country failed; tag left without coordinates", "country", place.Country, "error", gerr)
			}
			hasCoords = gerr == nil
		}
		var created bool
		country, created, err = s.findOrCreatePlaceTag(ctx, place.Country, cLat, cLon, hasCoords)
		if err != nil {
			return models.Tag{}, err
		}
		hasCountry = true
		if created {
			s.linkUnderBase(ctx, country, "countries", "country")
		}
	}

	target := country
	if place.City != "" {
		city, created, err := s.findOrCreatePlaceTag(ctx, place.City, place.CityLat, place.CityLon, place.HasCityCoords)
		if err != nil {
			return models.Tag{}, err
		}
		if created {
			if hasCountry {
				if err := s.AddTagRelationship(ctx, country.ID, city.ID); err != nil {
					slog.Warn("link city under country failed", "city", city.Name, "country", country.Name, "error", err)
				}
			} else {
				s.linkUnderBase(ctx, city, "cities", "city")
			}
		}
		target = city
	}

	if err := s.repo.AddTagToPost(ctx, models.AddTagToPostParams{PostID: postID, TagID: target.ID}); err != nil {
		return models.Tag{}, fmt.Errorf("attach location tag to post: %w", err)
	}

	_ = s.repo.UpdateAllTagPostCounts(ctx)
	s.Invalidate()
	return target, nil
}

// UpdateMissingCoords geocodes city/country descendant tags that have no coordinates.
// Uses the Nominatim OpenStreetMap API (1 req/sec rate limit).
func (s *TagService) UpdateMissingCoords(ctx context.Context) (map[string]interface{}, error) {
	// Find base category tags
	baseTags, err := s.repo.FindTagsByNames(ctx, []string{"city", "cities", "country", "countries"})
	if err != nil {
		return nil, err
	}
	if len(baseTags) == 0 {
		return map[string]interface{}{
			"status":        "success",
			"updated_count": 0,
			"message":       "No base tags (city/country) found.",
		}, nil
	}

	// Collect all descendant IDs (excluding the base tags themselves)
	baseIDs := map[int64]bool{}
	for _, bt := range baseTags {
		baseIDs[bt.ID] = true
	}

	allDescendantIDs := map[int64]bool{}
	for _, bt := range baseTags {
		descendants, err := s.repo.GetTagDescendants(ctx, bt.ID)
		if err != nil {
			continue
		}
		for _, d := range descendants {
			if !baseIDs[d.ID] {
				allDescendantIDs[d.ID] = true
			}
		}
	}

	if len(allDescendantIDs) == 0 {
		return map[string]interface{}{
			"status":        "success",
			"updated_count": 0,
			"message":       "No sub-tags found for city/country.",
		}, nil
	}

	ids := make([]int64, 0, len(allDescendantIDs))
	for id := range allDescendantIDs {
		ids = append(ids, id)
	}

	// Filter to those without coordinates
	tagsToGeocode, err := s.repo.GetTagsWithoutLocation(ctx, ids)
	if err != nil {
		return nil, err
	}
	if len(tagsToGeocode) == 0 {
		return map[string]interface{}{
			"status":        "success",
			"updated_count": 0,
			"message":       "All city/country tags already have coordinates.",
		}, nil
	}

	client := &http.Client{Timeout: 10 * time.Second}
	updatedCount := 0
	var errors []string

	for _, tag := range tagsToGeocode {
		params := url.Values{
			"q":      {tag.Name},
			"format": {"json"},
			"limit":  {"1"},
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet,
			s.nominatimBaseURL+"?"+params.Encode(), nil)
		if err != nil {
			errors = append(errors, fmt.Sprintf("build request for %s: %v", tag.Name, err))
			continue
		}
		req.Header.Set("User-Agent", "Point/1.0.0")

		resp, err := client.Do(req)
		if err != nil {
			errors = append(errors, fmt.Sprintf("geocode %s: %v", tag.Name, err))
			time.Sleep(1100 * time.Millisecond)
			continue
		}

		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()

		var results []struct {
			Lat string `json:"lat"`
			Lon string `json:"lon"`
		}
		if err := json.Unmarshal(body, &results); err != nil || len(results) == 0 {
			errors = append(errors, fmt.Sprintf("no results for %s", tag.Name))
			time.Sleep(1100 * time.Millisecond)
			continue
		}

		var lat, lon float64
		_, _ = fmt.Sscanf(results[0].Lat, "%f", &lat)
		_, _ = fmt.Sscanf(results[0].Lon, "%f", &lon)

		if err := s.repo.UpsertTagLocation(ctx, tag.ID, lat, lon); err != nil {
			errors = append(errors, fmt.Sprintf("save %s: %v", tag.Name, err))
		} else {
			updatedCount++
		}

		// Respect Nominatim rate limit: max 1 request per second
		time.Sleep(1100 * time.Millisecond)
	}

	if updatedCount > 0 {
		s.Invalidate()
	}

	result := map[string]interface{}{
		"status":        "success",
		"updated_count": updatedCount,
		"message":       fmt.Sprintf("Updated coordinates for %d tags.", updatedCount),
	}
	if len(errors) > 0 {
		result["errors"] = errors
	}
	return result, nil
}
