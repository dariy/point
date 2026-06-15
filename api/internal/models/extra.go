package models

// TagLocation represents a tag's geographic coordinates.
// This is used for backward compatibility with existing code after folding
// the tag_locations table into the tags table.
type TagLocation struct {
	ID        int64   `json:"id"`
	TagID     int64   `json:"tag_id"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}
