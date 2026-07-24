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

	params := url.Values{
		"q":      {tag.Name},
		"format": {"json"},
		"limit":  {"1"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		s.nominatimBaseURL+"?"+params.Encode(), nil)
	if err != nil {
		return 0, 0, err
	}
	req.Header.Set("User-Agent", "Point/1.0.0")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer func() {
		_ = resp.Body.Close()
	}()
	body, _ := io.ReadAll(resp.Body)

	var results []struct {
		Lat string `json:"lat"`
		Lon string `json:"lon"`
	}
	if err := json.Unmarshal(body, &results); err != nil || len(results) == 0 {
		return 0, 0, fmt.Errorf("no geocoding results for %q", tag.Name)
	}

	var lat, lon float64
	_, _ = fmt.Sscanf(results[0].Lat, "%f", &lat)
	_, _ = fmt.Sscanf(results[0].Lon, "%f", &lon)

	if err := s.repo.UpsertTagLocation(ctx, id, lat, lon); err != nil {
		return 0, 0, err
	}
	s.Invalidate()
	return lat, lon, nil
}

// reverseGeocode resolves the name of the populated place at the given
// coordinates via the Nominatim reverse API. It returns the most specific
// place name available (city, then town/village/municipality, then county,
// state, and finally country). An error is returned when the lookup fails or
// no usable place name is present.
func (s *TagService) reverseGeocode(ctx context.Context, lat, lon float64) (string, error) {
	params := url.Values{
		"lat":            {strconv.FormatFloat(lat, 'f', -1, 64)},
		"lon":            {strconv.FormatFloat(lon, 'f', -1, 64)},
		"format":         {"jsonv2"},
		"zoom":           {"10"}, // city level
		"addressdetails": {"1"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		s.nominatimReverseURL+"?"+params.Encode(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Point/1.0.0")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() {
		_ = resp.Body.Close()
	}()
	body, _ := io.ReadAll(resp.Body)

	var result struct {
		Name    string `json:"name"`
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
		return "", fmt.Errorf("parse reverse geocode response: %w", err)
	}

	a := result.Address
	for _, candidate := range []string{
		a.City, a.Town, a.Village, a.Municipality, a.Hamlet, a.Suburb,
		a.County, a.State, result.Name, a.Country,
	} {
		if name := strings.TrimSpace(candidate); name != "" {
			return name, nil
		}
	}
	return "", fmt.Errorf("no place name for coordinates %f,%f", lat, lon)
}

// TagPostWithLocation reverse-geocodes the given coordinates to a place name,
// finds or creates a location tag carrying those coordinates, and attaches the
// tag to the post. It is best-effort: callers may ignore the returned error.
func (s *TagService) TagPostWithLocation(ctx context.Context, postID int64, lat, lon float64) (models.Tag, error) {
	name, err := s.reverseGeocode(ctx, lat, lon)
	if err != nil {
		return models.Tag{}, err
	}

	slug := utils.Slugify(name)
	tag, err := s.repo.GetTagBySlug(ctx, slug)
	if err != nil {
		// Tag does not exist yet — create it with the coordinates.
		tag, err = s.repo.CreateTag(ctx, models.CreateTagParams{
			Name:      name,
			Slug:      slug,
			Latitude:  sql.NullFloat64{Float64: lat, Valid: true},
			Longitude: sql.NullFloat64{Float64: lon, Valid: true},
		})
		if err != nil {
			return models.Tag{}, fmt.Errorf("create location tag %q: %w", name, err)
		}
	} else if !tag.Latitude.Valid || !tag.Longitude.Valid {
		// Existing tag without coordinates — backfill them.
		if err := s.repo.UpsertTagLocation(ctx, tag.ID, lat, lon); err != nil {
			return models.Tag{}, fmt.Errorf("set location for tag %q: %w", name, err)
		}
	}

	if err := s.repo.AddTagToPost(ctx, models.AddTagToPostParams{PostID: postID, TagID: tag.ID}); err != nil {
		return models.Tag{}, fmt.Errorf("attach location tag to post: %w", err)
	}

	_ = s.repo.UpdateAllTagPostCounts(ctx)
	s.Invalidate()
	return tag, nil
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
