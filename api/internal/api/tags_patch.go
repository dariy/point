package api

// Partial-update decoding for PUT/PATCH /api/tags/:id.
//
// Both verbs use present-key semantics: a field the body omits keeps its
// current value, a field it sends as null is cleared. That distinction needs
// the raw JSON — a struct bind cannot tell "absent" from "zero" — so the body
// is decoded into map[string]json.RawMessage and applied key by key.

import (
	"encoding/json"

	"point-api/internal/models"
	"point-api/internal/services"
)

// tagPatchParams seeds UpdateTagParams from the tag's current values, then
// overrides only the fields present in the JSON body.
func tagPatchParams(current models.Tag, fields map[string]json.RawMessage) services.UpdateTagParams {
	p := services.UpdateTagParams{
		ID:               current.ID,
		Name:             current.Name,
		Slug:             current.Slug,
		Kind:             current.Kind,
		Hidden:           current.Hidden,
		HidesPosts:       current.HidesPosts,
		InBreadcrumbs:    current.InBreadcrumbs,
		ShowRelated:      current.ShowRelated,
		InAncestorFlyout: current.InAncestorFlyout,
	}
	if current.Description.Valid {
		p.Description = current.Description.String
	}
	if current.NavOrder.Valid {
		v := current.NavOrder.Int64
		p.NavOrder = &v
	}
	if current.Latitude.Valid {
		v := current.Latitude.Float64
		p.Latitude = &v
	}
	if current.Longitude.Valid {
		v := current.Longitude.Float64
		p.Longitude = &v
	}

	patchScalar(fields, "name", &p.Name)
	patchScalar(fields, "slug", &p.Slug)
	patchScalar(fields, "kind", &p.Kind)
	patchScalar(fields, "hidden", &p.Hidden)
	patchScalar(fields, "hides_posts", &p.HidesPosts)
	patchScalar(fields, "in_breadcrumbs", &p.InBreadcrumbs)
	patchScalar(fields, "show_related", &p.ShowRelated)
	patchScalar(fields, "in_ancestor_flyout", &p.InAncestorFlyout)

	patchNullable(fields, "nav_order", &p.NavOrder)
	patchNullable(fields, "latitude", &p.Latitude)
	patchNullable(fields, "longitude", &p.Longitude)

	// Description is a plain string in the params but nullable in the column,
	// so an explicit null clears it rather than leaving the current text.
	if raw, ok := fields["description"]; ok {
		if isJSONNull(raw) {
			p.Description = ""
		} else {
			_ = json.Unmarshal(raw, &p.Description)
		}
	}

	return p
}

// patchScalar overwrites dst when key is present in the body. Values that fail
// to parse leave the seeded value alone.
func patchScalar[T any](fields map[string]json.RawMessage, key string, dst *T) {
	if raw, ok := fields[key]; ok {
		_ = json.Unmarshal(raw, dst)
	}
}

// patchNullable overwrites an optional field when key is present, clearing it
// on an explicit null. A present-but-unparseable value lands as the zero value
// rather than being ignored: the client asked for the field to be set.
func patchNullable[T any](fields map[string]json.RawMessage, key string, dst **T) {
	raw, ok := fields[key]
	if !ok {
		return
	}
	if isJSONNull(raw) {
		*dst = nil
		return
	}
	var v T
	_ = json.Unmarshal(raw, &v)
	*dst = &v
}

// patchIDList reads an id array from the body. The second result is false when
// the key is absent, null or malformed — all cases where the corresponding
// relationships should be left untouched. A present empty array reports true,
// which is how a caller clears every relationship.
func patchIDList(fields map[string]json.RawMessage, key string) ([]int64, bool) {
	raw, ok := fields[key]
	if !ok || isJSONNull(raw) {
		return nil, false
	}
	var ids []int64
	if json.Unmarshal(raw, &ids) != nil {
		return nil, false
	}
	return ids, true
}

func isJSONNull(raw json.RawMessage) bool {
	return string(raw) == "null"
}
